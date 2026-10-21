import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";
import { type FieldInput, storedFieldValue } from "../contacts/fields";
import { fillEmailHashes, insertContacts, setFieldValues } from "../contacts/writes";
import { idList } from "./model";
import { type SignupState, signupOfToken } from "./signup";

// The confirmation of a signup (U8, F1, R12, KTD7). Only a POST from the Confirm button
// gets here, so a mail scanner that opens the link with GET confirms nothing.
//
// In one atomic batch:
// - The contact is created, or the existing contact is used. A confirmation is the
//   subscriber's newest action, so an earlier "unsubscribe from all" is lifted.
// - The consent basis becomes `explicit_opt_in` (double opt-in through a form), and a
//   consent event is appended, also when the basis was already explicit. Its form
//   evidence goes to `form_consents`: the form, the consent text version, the IP hash,
//   and the user agent.
// - Each list of the form that still exists gets a subscribed membership.
// - The answers of the fields that the form still shows are saved. A choice value whose
//   option was deleted since the submission is left out.
// - The signup is marked as confirmed, and its answers are cleared.

/** The consent basis of a confirmed signup. The consent model has no separate value. */
export const FORM_CONSENT_BASIS = "explicit_opt_in" as const;
/** `consent_events.source`, `contacts.source`, and `list_members.status_source` of a form. */
export const FORM_SOURCE = "form";

export type ConfirmOutcome =
  | { kind: "invalid" | "expired" }
  | { kind: "confirmed"; contactId: number; already: boolean; state: SignupState };

function parseValues(json: string | null): Record<string, FieldInput> {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, FieldInput>)
      : {};
  } catch {
    return {};
  }
}

export async function confirmSignup(
  db: DbConnection,
  token: string,
  now: number,
): Promise<ConfirmOutcome> {
  const state = await signupOfToken(db, token, now);
  if (state.kind === "invalid") return { kind: "invalid" };
  if (state.kind === "expired") return { kind: "expired" };
  const { signup, form } = state;
  const workspaceId = signup.workspace_id;
  const email = signup.email;
  const contactOf = () =>
    db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", email)
      .executeTakeFirst();
  if (state.kind === "confirmed") {
    const contact = await contactOf();
    return contact
      ? { kind: "confirmed", contactId: contact.id, already: true, state }
      : { kind: "invalid" };
  }

  // The address can have been suppressed or erased since the submission.
  const suppressed = await db.db
    .selectFrom("suppressions")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email_hash", "=", signup.email_hash)
    .executeTakeFirst();
  if (suppressed) return { kind: "invalid" };

  const listIds = idList(form.row.list_ids);
  const lists =
    listIds.length === 0
      ? []
      : (
          await db.db
            .selectFrom("lists")
            .select("id")
            .where("workspace_id", "=", workspaceId)
            .where("id", "in", listIds)
            .execute()
        ).map((row) => row.id);

  const answers = parseValues(signup.field_values);
  const fieldWrites = [];
  for (const def of form.defs) {
    const raw = answers[def.key];
    if (raw === undefined) continue;
    let value: string | null;
    try {
      value = storedFieldValue(def, raw);
    } catch {
      continue;
    }
    fieldWrites.push(...setFieldValues(db.db, workspaceId, def.id, [{ email, value }], now));
  }

  const actorId = `form:${form.row.id}`;
  const note = `Double opt-in through the signup form "${form.row.name.slice(0, 100)}".`;
  const contactId = sql<number>`(SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email = ${email})`;
  await db.atomic([
    ...insertContacts(
      db.db,
      workspaceId,
      [{ email, emailHash: signup.email_hash, firstName: null, lastName: null }],
      { consentBasis: FORM_CONSENT_BASIS, consentSource: FORM_SOURCE, source: FORM_SOURCE, now },
    ),
    ...fillEmailHashes(db.db, workspaceId, [{ email, emailHash: signup.email_hash }]),
    db.db
      .updateTable("contacts")
      .set({
        consent_basis: FORM_CONSENT_BASIS,
        consent_source: FORM_SOURCE,
        consent_at: now,
        unsubscribed_at: null,
        unsubscribe_source: null,
        unsubscribe_campaign_id: null,
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", email),
    sql`INSERT INTO consent_events (workspace_id, contact_id, basis, source, actor_type, actor_id, note, created_at)
VALUES (${workspaceId}, ${contactId}, ${FORM_CONSENT_BASIS}, ${FORM_SOURCE}, 'system', ${actorId}, ${note}, ${now})`.compile(
      db.db,
    ),
    sql`INSERT INTO form_consents (workspace_id, consent_event_id, form_id, consent_version, ip_hash, user_agent, created_at)
VALUES (${workspaceId}, (SELECT max(id) FROM consent_events WHERE workspace_id = ${workspaceId} AND contact_id = ${contactId}),
  ${form.row.id}, ${signup.consent_version}, ${signup.ip_hash}, ${signup.user_agent}, ${now})`.compile(
      db.db,
    ),
    ...(lists.length === 0
      ? []
      : [
          sql`INSERT INTO list_members (workspace_id, list_id, contact_id, status, status_source, status_at, status_campaign_id, created_at)
SELECT ${workspaceId}, l.id, ${contactId}, 'subscribed', ${FORM_SOURCE}, ${now}, NULL, ${now}
FROM lists l WHERE l.workspace_id = ${workspaceId} AND l.id IN (SELECT value FROM json_each(${JSON.stringify(lists)}))
ON CONFLICT (list_id, contact_id) DO UPDATE SET status = 'subscribed', status_source = excluded.status_source,
  status_at = excluded.status_at, status_campaign_id = NULL
WHERE list_members.status <> 'subscribed'`.compile(db.db),
        ]),
    ...fieldWrites,
    db.db
      .updateTable("signups")
      .set({ confirmed_at: now, field_values: null })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", signup.id),
  ]);
  const contact = await contactOf();
  if (!contact) return { kind: "invalid" };
  return { kind: "confirmed", contactId: contact.id, already: false, state };
}

/** Deletes signups 7 days after they were created, once their link has expired. */
export async function purgeExpiredSignups(
  db: DbConnection,
  now: number,
  retentionMs = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  // A deployment-wide cleanup, as the event retention job.
  const result = await unscoped(db.db)
    .deleteFrom("signups")
    .where("created_at", "<", now - retentionMs)
    .where((eb) => eb.or([eb("expires_at", "<", now), eb("confirmed_at", "is not", null)]))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
