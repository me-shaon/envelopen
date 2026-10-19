import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";

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
  const [lists, suppression] = await Promise.all([
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
  };
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
 * Applies the list choices of the preference page: each of the contact's lists in
 * `subscribedIds` is subscribed, every other one is unsubscribed. Ids of lists that the
 * contact is not in are ignored. Returns how many memberships changed each way.
 */
export async function savePreferences(
  db: DbConnection,
  target: Subscription,
  subscribedIds: ReadonlySet<number>,
  now: number,
): Promise<{ unsubscribed: number; resubscribed: number }> {
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
  AND list_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`.compile(db.db);
  const queries = [];
  if (leave.length > 0) queries.push(update(leave, "unsubscribed"));
  if (join.length > 0) queries.push(update(join, "subscribed"));
  const results = await db.atomic(queries);
  const changes = results.map((result) => result.meta.changes ?? 0);
  return {
    unsubscribed: leave.length > 0 ? (changes[0] ?? 0) : 0,
    resubscribed: join.length > 0 ? (changes.at(-1) ?? 0) : 0,
  };
}
