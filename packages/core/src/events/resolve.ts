import { type DbConnection, unscoped } from "@envelopen/db";

// Lookups of tracking hits (R40). A pixel or click token names a campaign and a
// recipient, but no workspace, so these reads are deliberately cross-workspace (KTD4).
// The token's MAC is the credential: callers verify it first.

export interface TrackedRecipient {
  workspaceId: number;
  campaignId: number;
  recipientId: number;
  contactId: number | null;
  /** When the provider accepted the email. Null before the send. */
  sentAt: number | null;
}

export interface TrackedClick extends TrackedRecipient {
  linkId: number;
  url: string;
}

export async function resolveRecipient(
  db: DbConnection,
  ref: { campaignId: number; recipientId: number },
): Promise<TrackedRecipient | null> {
  const row = await unscoped(db.db)
    .selectFrom("campaign_recipients")
    .select(["workspace_id", "campaign_id", "id", "contact_id", "sent_at"])
    .where("id", "=", ref.recipientId)
    .where("campaign_id", "=", ref.campaignId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    recipientId: row.id,
    contactId: row.contact_id,
    sentAt: row.sent_at,
  };
}

/**
 * The recipient and the stored URL of link `index` of its campaign, in one query. The
 * URL comes only from the campaign's `links` table, never from the request, so the
 * redirect cannot point anywhere else (no open redirect).
 */
export async function resolveClick(
  db: DbConnection,
  ref: { campaignId: number; recipientId: number },
  index: number,
): Promise<TrackedClick | null> {
  const row = await unscoped(db.db)
    .selectFrom("campaign_recipients as r")
    .innerJoin("links as l", (join) =>
      join
        .onRef("l.workspace_id", "=", "r.workspace_id")
        .onRef("l.campaign_id", "=", "r.campaign_id")
        .on("l.idx", "=", index),
    )
    .select([
      "r.workspace_id",
      "r.campaign_id",
      "r.id",
      "r.contact_id",
      "r.sent_at",
      "l.id as link_id",
      "l.url",
    ])
    .where("r.id", "=", ref.recipientId)
    .where("r.campaign_id", "=", ref.campaignId)
    .executeTakeFirst();
  if (!row || !isHttpUrl(row.url)) return null;
  return {
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    recipientId: row.id,
    contactId: row.contact_id,
    sentAt: row.sent_at,
    linkId: row.link_id,
    url: row.url,
  };
}

/** Only http and https targets. The send path stores no other kind, and this checks it again. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
