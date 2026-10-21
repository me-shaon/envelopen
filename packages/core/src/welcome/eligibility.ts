import type { DbConnection, Row } from "@envelopen/db";
import { sql } from "kysely";
import type { EmailHasher } from "../services";
import type { WelcomeJob } from "./model";

// Who may get a welcome step (R16, KTD8). Two checks use these rules:
//
// - At the start: an enabled series of the list, a subscribed membership, a contact that
//   did not unsubscribe from all, an address that is not suppressed, and no earlier
//   `welcome_sends` row of the contact in the series. The last rule keeps a resubscribe
//   from starting the series again after the Workflow forgot the instance id.
// - Before each step: the same rules again, read fresh from D1, and no unsubscribe that
//   waits in the UnsubscribeLedger (KTD1). The series must still be enabled, so a series
//   that the owner turned off stops at the next check.

export type StopReason =
  | "series_missing"
  | "series_disabled"
  | "contact_missing"
  | "unsubscribed"
  | "left_list"
  | "suppressed"
  | "unsubscribe_pending";

export interface EligibleContact {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export type Eligibility =
  | { ok: true; contact: EligibleContact }
  | { ok: false; reason: StopReason };

export interface EligibilityDeps {
  db: DbConnection;
  hashEmail: EmailHasher;
  /** True while the UnsubscribeLedger holds intents (the UsageMeter flag). */
  unsubscribesPending: boolean;
  /** The contacts with an unsubscribe in the UnsubscribeLedger (KTD1). */
  pendingUnsubscribes(workspaceId: number, contactIds: readonly number[]): Promise<Set<number>>;
}

/** The checks before one step of one contact. */
export async function checkStepEligibility(
  deps: EligibilityDeps,
  series: Row<"welcome_series"> | undefined,
  job: WelcomeJob,
): Promise<Eligibility> {
  const { db } = deps;
  const { workspaceId, contactId } = job;
  if (!series) return { ok: false, reason: "series_missing" };
  if (series.enabled !== 1) return { ok: false, reason: "series_disabled" };
  const contact = await db.db
    .selectFrom("contacts as c")
    .leftJoin("list_members as m", (join) =>
      join
        .onRef("m.contact_id", "=", "c.id")
        .on("m.workspace_id", "=", workspaceId)
        .on("m.list_id", "=", series.list_id),
    )
    .select([
      "c.id",
      "c.email",
      "c.email_hash",
      "c.first_name",
      "c.last_name",
      "c.unsubscribed_at",
      "m.status as member_status",
    ])
    .where("c.workspace_id", "=", workspaceId)
    .where("c.id", "=", contactId)
    .executeTakeFirst();
  if (!contact) return { ok: false, reason: "contact_missing" };
  if (contact.unsubscribed_at !== null) return { ok: false, reason: "unsubscribed" };
  if (contact.member_status !== "subscribed") return { ok: false, reason: "left_list" };
  const emailHash = contact.email_hash ?? (await deps.hashEmail(contact.email));
  const suppressed = await db.db
    .selectFrom("suppressions")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email_hash", "=", emailHash)
    .executeTakeFirst();
  if (suppressed) return { ok: false, reason: "suppressed" };
  if (deps.unsubscribesPending) {
    const waiting = await deps.pendingUnsubscribes(workspaceId, [contactId]);
    if (waiting.has(contactId)) return { ok: false, reason: "unsubscribe_pending" };
  }
  return {
    ok: true,
    contact: {
      id: contact.id,
      email: contact.email,
      firstName: contact.first_name,
      lastName: contact.last_name,
    },
  };
}

/**
 * The (series, contact) pairs that may start: the enabled series of `listIds`, and the
 * contacts of `contactIds` that are subscribed to the series list, did not unsubscribe
 * from all, are not suppressed, and have no row of the series yet. One query.
 */
export async function startableJobs(
  db: DbConnection,
  workspaceId: number,
  contactIds: readonly number[],
  listIds: readonly number[],
): Promise<WelcomeJob[]> {
  if (contactIds.length === 0 || listIds.length === 0) return [];
  const { rows } = await sql<{ series_id: number; contact_id: number }>`
SELECT s.id AS series_id, c.id AS contact_id
FROM welcome_series s
JOIN list_members m ON m.workspace_id = ${workspaceId} AND m.list_id = s.list_id AND m.status = 'subscribed'
JOIN contacts c ON c.workspace_id = ${workspaceId} AND c.id = m.contact_id AND c.unsubscribed_at IS NULL
WHERE s.workspace_id = ${workspaceId} AND s.enabled = 1
  AND s.list_id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(listIds)])}))
  AND c.id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(contactIds)])}))
  AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.workspace_id = ${workspaceId} AND x.email_hash = c.email_hash)
  AND NOT EXISTS (SELECT 1 FROM welcome_sends w WHERE w.workspace_id = ${workspaceId} AND w.series_id = s.id AND w.contact_id = c.id)
ORDER BY s.id, c.id`.execute(db.db);
  return rows.map((row) => ({ workspaceId, seriesId: row.series_id, contactId: row.contact_id }));
}
