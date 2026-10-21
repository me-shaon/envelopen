import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";
import { loadFieldDefs } from "../contacts/fields";
import type { PreferenceField } from "../forms/answers";

// Unsubscribe and preferences (R24, R25, R64, F3). The public pages under `/u/` call
// these with the recipient from a verified token. The token holds no workspace id, so
// the lookup is the one deliberate cross-workspace read here (KTD4). Every write after
// it names the workspace of that recipient.
//
// An unsubscribe never deletes the contact. It sets the contact's `unsubscribed_at`
// with the source and the campaign, and moves each subscribed list membership to
// `unsubscribed` with the same source, time, and campaign. The owner sees the contact
// with the status unsubscribed (F3).
//
// Sources: `one_click` for the RFC 8058 POST, `preference_page` for the page forms.
//
// At the D1 daily limit, the Worker keeps the unsubscribe in the UnsubscribeLedger
// Durable Object (KTD1). After the reset, `applyUnsubscribeIntent` writes it here with
// the time of the subscriber's click. The newest action wins: a membership whose status
// changed after that time stays as it is.

export type UnsubscribeSource = "one_click" | "preference_page";

export interface SubscriptionList {
  id: number;
  name: string;
  status: "subscribed" | "unsubscribed";
}

export interface Subscription {
  workspaceId: number;
  workspaceName: string;
  campaignId: number;
  recipientId: number;
  contactId: number;
  email: string;
  unsubscribedAt: number | null;
  /** The address is on the suppression list (a bounce or a complaint). */
  suppressed: boolean;
  lists: SubscriptionList[];
  /**
   * The custom fields that the preference page shows (R14), in field order: `read_only`
   * fields as text, `editable` fields as inputs. Hidden fields are left out.
   */
  fields: PreferenceField[];
}

/** The contact behind a recipient, or null when the recipient or its contact is gone. */
export async function loadSubscription(
  db: DbConnection,
  ref: { campaignId: number; recipientId: number },
): Promise<Subscription | null> {
  // The token is the credential: the recipient id and campaign id come from its MAC.
  const row = await unscoped(db.db)
    .selectFrom("campaign_recipients as r")
    .innerJoin("contacts as c", (join) =>
      join.onRef("c.id", "=", "r.contact_id").onRef("c.workspace_id", "=", "r.workspace_id"),
    )
    .innerJoin("workspaces as w", "w.id", "r.workspace_id")
    .select([
      "r.workspace_id",
      "r.campaign_id",
      "r.id",
      "c.id as contact_id",
      "c.email",
      "c.email_hash",
      "c.unsubscribed_at",
      "w.name as workspace_name",
    ])
    .where("r.id", "=", ref.recipientId)
    .where("r.campaign_id", "=", ref.campaignId)
    .executeTakeFirst();
  if (!row) return null;
  const workspaceId = row.workspace_id;
  const [lists, suppression, fields] = await Promise.all([
    db.db
      .selectFrom("list_members as m")
      .innerJoin("lists as l", (join) =>
        join.onRef("l.id", "=", "m.list_id").on("l.workspace_id", "=", workspaceId),
      )
      .select(["l.id", "l.name", "m.status"])
      .where("m.workspace_id", "=", workspaceId)
      .where("m.contact_id", "=", row.contact_id)
      .orderBy("l.name")
      .execute(),
    row.email_hash
      ? db.db
          .selectFrom("suppressions")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("email_hash", "=", row.email_hash)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    preferenceFields(db, workspaceId, row.contact_id),
  ]);
  return {
    workspaceId,
    workspaceName: row.workspace_name,
    campaignId: row.campaign_id,
    recipientId: row.id,
    contactId: row.contact_id,
    email: row.email,
    unsubscribedAt: row.unsubscribed_at,
    suppressed: suppression !== undefined,
    lists,
    fields,
  };
}

/** The fields that the preference page shows, with the contact's values. */
async function preferenceFields(
  db: DbConnection,
  workspaceId: number,
  contactId: number,
): Promise<PreferenceField[]> {
  const defs = [...(await loadFieldDefs(db.db, workspaceId)).values()].filter(
    (def) => def.preference !== "hidden",
  );
  if (defs.length === 0) return [];
  const values = await db.db
    .selectFrom("contact_field_values")
    .select(["field_id", "value"])
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", contactId)
    .execute();
  const stored = new Map(values.map((row) => [row.field_id, row.value]));
  return defs.map((def) => ({
    id: def.id,
    key: def.key,
    label: def.label,
    type: def.type,
    kind: def.kind,
    options: def.options,
    preference: def.preference as PreferenceField["preference"],
    value: stored.get(def.id) ?? null,
  }));
}

/**
 * Unsubscribes the contact from every list. Returns false when the contact was
 * unsubscribed already, so a repeated one-click POST records no second event.
 */
export async function unsubscribeAll(
  db: DbConnection,
  target: Subscription,
  source: UnsubscribeSource,
  now: number,
): Promise<boolean> {
  const { workspaceId, contactId, campaignId } = target;
  const [contact] = await db.atomic([
    db.db
      .updateTable("contacts")
      .set({
        unsubscribed_at: now,
        unsubscribe_source: source,
        unsubscribe_campaign_id: campaignId,
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", contactId)
      .where("unsubscribed_at", "is", null),
    db.db
      .updateTable("list_members")
      .set({
        status: "unsubscribed",
        status_source: source,
        status_at: now,
        status_campaign_id: campaignId,
      })
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", contactId)
      .where("status", "=", "subscribed"),
  ]);
  return (contact?.meta.changes ?? 0) > 0;
}

/**
 * Undoes an unsubscribe from all: clears the contact's unsubscribe and subscribes the
 * memberships that the unsubscribe changed (those with its time) again. A list that the
 * contact left on another day stays left. Returns false when nothing changed.
 */
export async function resubscribe(
  db: DbConnection,
  target: Subscription,
  now: number,
): Promise<boolean> {
  const { workspaceId, contactId, unsubscribedAt } = target;
  if (unsubscribedAt === null) return false;
  const [, contact] = await db.atomic([
    db.db
      .updateTable("list_members")
      .set({ status: "subscribed", status_source: "preference_page", status_at: now })
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", contactId)
      .where("status", "=", "unsubscribed")
      .where("status_at", "=", unsubscribedAt),
    db.db
      .updateTable("contacts")
      .set({
        unsubscribed_at: null,
        unsubscribe_source: null,
        unsubscribe_campaign_id: null,
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", contactId)
      .where("unsubscribed_at", "=", unsubscribedAt),
  ]);
  return (contact?.meta.changes ?? 0) > 0;
}

/**
 * Applies the list choices and the field answers of the preference page in one atomic
 * batch. Each of the contact's lists in `subscribedIds` is subscribed, every other one is
 * unsubscribed. Ids of lists that the contact is not in are ignored. `fieldValues` holds
 * the stored values of the changed editable fields by field id (null clears a value).
 * Returns how many memberships changed each way and how many field values changed.
 */
export async function savePreferences(
  db: DbConnection,
  target: Subscription,
  subscribedIds: ReadonlySet<number>,
  now: number,
  fieldValues: ReadonlyMap<number, string | null> = new Map(),
): Promise<{ unsubscribed: number; resubscribed: number; fields: number }> {
  const { workspaceId, contactId, campaignId } = target;
  const leave = target.lists
    .filter((list) => list.status === "subscribed" && !subscribedIds.has(list.id))
    .map((list) => list.id);
  const join = target.lists
    .filter((list) => list.status === "unsubscribed" && subscribedIds.has(list.id))
    .map((list) => list.id);
  const update = (ids: number[], status: "subscribed" | "unsubscribed") =>
    sql`UPDATE list_members SET status = ${status}, status_source = 'preference_page', status_at = ${now}, status_campaign_id = ${campaignId}
WHERE workspace_id = ${workspaceId} AND contact_id = ${contactId} AND status <> ${status}
  AND list_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
RETURNING list_id`.compile(db.db);
  // Only the editable fields of the page. An id of another field is ignored.
  const editable = new Set(
    target.fields.filter((field) => field.preference === "editable").map((field) => field.id),
  );
  const answers = [...fieldValues].filter(([fieldId]) => editable.has(fieldId));
  const queries = [];
  if (leave.length > 0) queries.push(update(leave, "unsubscribed"));
  if (join.length > 0) queries.push(update(join, "subscribed"));
  const listQueries = queries.length;
  if (answers.length > 0) {
    // One JSON parameter carries every answer: [[field id, value], ...].
    queries.push(
      sql`INSERT INTO contact_field_values (workspace_id, contact_id, field_id, value, updated_at)
SELECT ${workspaceId}, ${contactId}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ${now}
FROM json_each(${JSON.stringify(answers)}) AS j
WHERE EXISTS (SELECT 1 FROM contact_fields f WHERE f.workspace_id = ${workspaceId} AND f.id = json_extract(j.value, '$[0]'))
ON CONFLICT (contact_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`.compile(
        db.db,
      ),
      db.db
        .updateTable("contacts")
        .set({ updated_at: now })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", contactId)
        .compile(),
    );
  }
  const results = await db.atomic(queries);
  // The returned rows, not meta.changes: D1 adds the rows that the member count
  // trigger writes (migration 0014).
  const changes = results.slice(0, listQueries).map((result) => result.results?.length ?? 0);
  return {
    unsubscribed: leave.length > 0 ? (changes[0] ?? 0) : 0,
    resubscribed: join.length > 0 ? (changes.at(-1) ?? 0) : 0,
    fields: answers.length,
  };
}

/** An unsubscribe that D1 rejected at its daily limit, as the ledger kept it (KTD1). */
export interface UnsubscribeIntent {
  workspaceId: number;
  contactId: number;
  campaignId: number;
  /** The list to leave, or null for every list (an unsubscribe from all). */
  listId: number | null;
  source: UnsubscribeSource;
  /** When the subscriber asked, Unix milliseconds. */
  at: number;
}

/**
 * Writes an unsubscribe from the ledger with the time of the request. The newest action
 * wins: a membership whose status changed after `at` (for example a resubscribe after the
 * reset) is not changed. For an unsubscribe from all, the contact is marked unsubscribed
 * only when no list was subscribed again after `at`. An edit of other contact fields does
 * not count as a newer action. Returns true when something changed.
 */
export async function applyUnsubscribeIntent(
  db: DbConnection,
  intent: UnsubscribeIntent,
  now: number,
): Promise<boolean> {
  const { workspaceId, contactId, campaignId, listId, source, at } = intent;
  const members =
    sql`UPDATE list_members SET status = 'unsubscribed', status_source = ${source}, status_at = ${at}, status_campaign_id = ${campaignId}
WHERE workspace_id = ${workspaceId} AND contact_id = ${contactId} AND status = 'subscribed'
  AND status_at <= ${at}${listId === null ? sql`` : sql` AND list_id = ${listId}`}
RETURNING list_id`.compile(db.db);
  if (listId !== null) {
    const [result] = await db.atomic([members]);
    // The returned rows, not meta.changes: the member count trigger adds its own rows.
    return (result?.results?.length ?? 0) > 0;
  }
  const contact =
    sql`UPDATE contacts SET unsubscribed_at = ${at}, unsubscribe_source = ${source}, unsubscribe_campaign_id = ${campaignId}, updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${contactId} AND unsubscribed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM list_members m WHERE m.workspace_id = ${workspaceId}
    AND m.contact_id = ${contactId} AND m.status = 'subscribed' AND m.status_at > ${at})
RETURNING id`.compile(db.db);
  // The contact first, so its check sees the memberships before this change.
  const [changedContact, changedMembers] = await db.atomic([contact, members]);
  return (changedContact?.results?.length ?? 0) > 0 || (changedMembers?.results?.length ?? 0) > 0;
}

/** The workspace and contact behind a recipient of an unsubscribe link. */
export interface RecipientTarget {
  workspaceId: number;
  contactId: number;
}

/**
 * The workspace and contact of each recipient, keyed by recipient id, from D1. Each ref
 * names the campaign of the token too: a recipient of another campaign does not match.
 * With `workspaceId`, only the recipients of that workspace. Without it, the lookup is
 * the deliberate cross-workspace read of a verified token (KTD4). A recipient whose
 * contact is gone is left out.
 */
export async function recipientTargets(
  db: DbConnection,
  refs: readonly { campaignId: number; recipientId: number }[],
  workspaceId?: number,
): Promise<Map<number, RecipientTarget>> {
  const targets = new Map<number, RecipientTarget>();
  if (refs.length === 0) return targets;
  const ids = JSON.stringify([...new Set(refs.map((ref) => ref.recipientId))]);
  const scope = workspaceId === undefined ? sql`` : sql` AND workspace_id = ${workspaceId}`;
  const { rows } = await sql<{
    id: number;
    campaign_id: number;
    workspace_id: number;
    contact_id: number | null;
  }>`SELECT id, campaign_id, workspace_id, contact_id FROM campaign_recipients
WHERE id IN (SELECT value FROM json_each(${ids}))${scope}`.execute(
    workspaceId === undefined ? unscoped(db.db) : db.db,
  );
  const campaignOf = new Map(refs.map((ref) => [ref.recipientId, ref.campaignId]));
  for (const row of rows) {
    if (row.contact_id === null || campaignOf.get(row.id) !== row.campaign_id) continue;
    targets.set(row.id, { workspaceId: row.workspace_id, contactId: row.contact_id });
  }
  return targets;
}
