import type { CampaignType, Database, DbConnection } from "@envelopen/db";
import { type Kysely, type RawBuilder, sql } from "kysely";
import {
  type Audience,
  type CampaignAudience,
  EXCLUSION_REASONS,
  type ExclusionCounts,
  emptyExclusions,
} from "./model";

// Who a campaign reaches (R31, KTD21, KTD22, KTD23). The estimate, the snapshot, and
// the send-time check share these SQL pieces, so they apply the same rules:
//
// - Targeted: a membership in a targeted list (any status) or a targeted tag.
// - Excluded by the owner: a membership in an excluded list, or an excluded tag.
// - Left out, with a reason:
//   - `suppressed`: the address hash is on the suppression list (R19, AE2).
//   - `unsubscribed`: unsubscribed from every list, or from each targeted list, with
//     no targeted tag to reach the contact another way (R64).
//   - `consent_unknown`: a regular campaign skips contacts whose consent basis is
//     unknown. A re-permission campaign includes them (AE1).
// - A follow-up (R35) targets only contacts that got its parent and have no human open
//   of it. `opened_at` is the first human open, so a contact with machine opens only
//   (for example Apple Mail Privacy Protection) stays in (KTD29). The send-time check
//   skips a contact who opened the parent after the snapshot, with reason `opened`.
//
// The fragments expect the contact as `c` and a LEFT JOIN of its suppression as `s`.
// Every subquery names its workspace, as the scope rule asks (KTD4).

function idList(ids: readonly number[]): RawBuilder<unknown> {
  return sql.join(ids.map((id) => sql`${id}`));
}

function inLists(workspaceId: number, listIds: readonly number[], status?: "subscribed") {
  return sql<boolean>`EXISTS (SELECT 1 FROM list_members m WHERE m.workspace_id = ${workspaceId} AND m.contact_id = c.id AND m.list_id IN (${idList(listIds)})${status ? sql` AND m.status = ${status}` : sql``})`;
}

function hasTags(workspaceId: number, tagIds: readonly number[]) {
  return sql<boolean>`EXISTS (SELECT 1 FROM contact_tags t WHERE t.workspace_id = ${workspaceId} AND t.contact_id = c.id AND t.tag_id IN (${idList(tagIds)}))`;
}

function anyOf(parts: RawBuilder<boolean>[]): RawBuilder<boolean> {
  return parts.length === 0 ? sql<boolean>`0` : sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}

/** The contact got the parent campaign and did not open it as a person. */
function parentNonOpener(workspaceId: number, parentId: number) {
  return sql<boolean>`EXISTS (SELECT 1 FROM campaign_recipients pr WHERE pr.workspace_id = ${workspaceId} AND pr.campaign_id = ${parentId} AND pr.contact_id = c.id AND pr.status = 'sent' AND pr.opened_at IS NULL)`;
}

/** The contact is in the audience before any rule. */
export function targeted(workspaceId: number, audience: CampaignAudience): RawBuilder<boolean> {
  const lists = anyOf([
    ...(audience.listIds.length > 0 ? [inLists(workspaceId, audience.listIds)] : []),
    ...(audience.tagIds.length > 0 ? [hasTags(workspaceId, audience.tagIds)] : []),
  ]);
  if (!audience.followUpOf) return lists;
  return sql<boolean>`(${lists} AND ${parentNonOpener(workspaceId, audience.followUpOf)})`;
}

/** The owner excluded the contact. */
export function excluded(workspaceId: number, audience: Audience): RawBuilder<boolean> {
  return anyOf([
    ...(audience.excludeListIds.length > 0 ? [inLists(workspaceId, audience.excludeListIds)] : []),
    ...(audience.excludeTagIds.length > 0 ? [hasTags(workspaceId, audience.excludeTagIds)] : []),
  ]);
}

/** The reason that a targeted contact gets no email, or NULL when it gets one. */
export function exclusionReason(
  workspaceId: number,
  audience: Audience,
  type: CampaignType,
): RawBuilder<string | null> {
  const reachable = anyOf([
    ...(audience.listIds.length > 0 ? [inLists(workspaceId, audience.listIds, "subscribed")] : []),
    ...(audience.tagIds.length > 0 ? [hasTags(workspaceId, audience.tagIds)] : []),
  ]);
  const consent =
    type === "regular" ? sql`WHEN c.consent_basis = 'unknown' THEN 'consent_unknown' ` : sql``;
  return sql<
    string | null
  >`CASE WHEN s.id IS NOT NULL THEN 'suppressed' WHEN c.unsubscribed_at IS NOT NULL THEN 'unsubscribed' WHEN NOT ${reachable} THEN 'unsubscribed' ${consent}ELSE NULL END`;
}

/** The suppression of the contact's address, as `s`. */
export function suppressionJoin(workspaceId: number) {
  return sql`LEFT JOIN suppressions s ON s.workspace_id = ${workspaceId} AND s.email_hash = c.email_hash`;
}

export interface AudienceEstimate {
  recipients: number;
  excluded: ExclusionCounts;
}

function countsFrom(rows: { reason: string | null; n: number }[]): AudienceEstimate {
  const estimate: AudienceEstimate = { recipients: 0, excluded: emptyExclusions() };
  for (const row of rows) {
    if (row.reason === null) estimate.recipients += Number(row.n);
    else if ((EXCLUSION_REASONS as readonly string[]).includes(row.reason)) {
      estimate.excluded[row.reason as keyof ExclusionCounts] += Number(row.n);
    }
  }
  return estimate;
}

/**
 * Counts the recipients that a snapshot would take now, and the contacts left out by
 * reason. It is an estimate: contacts can change before the snapshot (KTD22).
 */
export async function estimateAudience(
  db: DbConnection,
  workspaceId: number,
  audience: CampaignAudience,
  type: CampaignType,
): Promise<AudienceEstimate> {
  if (audience.listIds.length === 0 && audience.tagIds.length === 0) {
    return { recipients: 0, excluded: emptyExclusions() };
  }
  const { rows } = await sql<{ reason: string | null; n: number }>`
SELECT reason, count(*) AS n FROM (
  SELECT ${exclusionReason(workspaceId, audience, type)} AS reason
  FROM contacts c ${suppressionJoin(workspaceId)}
  WHERE c.workspace_id = ${workspaceId} AND ${targeted(workspaceId, audience)} AND NOT ${excluded(workspaceId, audience)}
) GROUP BY reason`.execute(db.db);
  return countsFrom(rows);
}

/** The exclusion counts of one snapshot page: contacts in (afterId, toId]. */
export function pageExclusionsQuery(
  db: Kysely<Database>,
  workspaceId: number,
  audience: CampaignAudience,
  type: CampaignType,
  afterId: number,
  toId: number,
) {
  return sql<{ reason: string | null; n: number }>`
SELECT reason, count(*) AS n FROM (
  SELECT ${exclusionReason(workspaceId, audience, type)} AS reason
  FROM contacts c ${suppressionJoin(workspaceId)}
  WHERE c.workspace_id = ${workspaceId} AND c.id > ${afterId} AND c.id <= ${toId}
    AND ${targeted(workspaceId, audience)} AND NOT ${excluded(workspaceId, audience)}
) WHERE reason IS NOT NULL GROUP BY reason`.compile(db);
}

export function exclusionCountsOf(rows: { reason: string | null; n: number }[]): ExclusionCounts {
  return countsFrom(rows).excluded;
}

/**
 * Inserts the recipients of one snapshot page: contacts in (afterId, toId] that the
 * campaign reaches. The unique (campaign, contact) key makes a retried page a no-op (R36).
 */
export function insertPageRecipientsQuery(
  db: Kysely<Database>,
  workspaceId: number,
  campaignId: number,
  audience: CampaignAudience,
  type: CampaignType,
  afterId: number,
  toId: number,
) {
  return sql`
INSERT INTO campaign_recipients (workspace_id, campaign_id, contact_id)
SELECT ${workspaceId}, ${campaignId}, c.id
FROM contacts c ${suppressionJoin(workspaceId)}
WHERE c.workspace_id = ${workspaceId} AND c.id > ${afterId} AND c.id <= ${toId}
  AND ${targeted(workspaceId, audience)} AND NOT ${excluded(workspaceId, audience)}
  AND (${exclusionReason(workspaceId, audience, type)}) IS NULL
ORDER BY c.id
ON CONFLICT (campaign_id, contact_id) DO NOTHING`.compile(db);
}

export interface CheckedRecipient {
  recipientId: number;
  contactId: number | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Null when the recipient gets the email. */
  skipReason: string | null;
}

/**
 * The send-time check of one batch (KTD21): one uncached query over the pending
 * recipients. It skips contacts that were deleted, suppressed (for example by a hard
 * bounce in an earlier batch, AE2), unsubscribed, excluded, or not eligible by consent.
 */
export async function checkBatchRecipients(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  batchId: number,
  audience: CampaignAudience,
  type: CampaignType,
): Promise<CheckedRecipient[]> {
  const opened = audience.followUpOf
    ? sql`WHEN NOT ${parentNonOpener(workspaceId, audience.followUpOf)} THEN 'opened' `
    : sql``;
  const { rows } = await sql<{
    recipient_id: number;
    contact_id: number | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    skip_reason: string | null;
  }>`
SELECT r.id AS recipient_id, c.id AS contact_id, c.email, c.first_name, c.last_name,
  CASE WHEN c.id IS NULL THEN 'deleted'
       WHEN ${excluded(workspaceId, audience)} THEN 'excluded'
       ${opened}ELSE ${exclusionReason(workspaceId, audience, type)} END AS skip_reason
FROM campaign_recipients r
LEFT JOIN contacts c ON c.workspace_id = ${workspaceId} AND c.id = r.contact_id
${suppressionJoin(workspaceId)}
WHERE r.workspace_id = ${workspaceId} AND r.campaign_id = ${campaignId} AND r.batch_id = ${batchId}
  AND r.status = 'pending'
ORDER BY r.id`.execute(db.db);
  return rows.map((row) => ({
    recipientId: row.recipient_id,
    contactId: row.contact_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    skipReason: row.skip_reason,
  }));
}
