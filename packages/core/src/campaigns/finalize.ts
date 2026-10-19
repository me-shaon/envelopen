import type { CampaignStatus, DbConnection } from "@envelopen/db";
import { sql } from "kysely";

// Finishing a campaign (KTD19). When no batch is pending, enqueued, or claimed, the
// campaign becomes `needs_decision` if a batch is uncertain, and `sent` otherwise. The
// consumer tries it after each batch, and the sweep tries it every minute. Both run
// the same single UPDATE, a compare-and-set on the campaign status, so when they race
// exactly one of them makes the change.
//
// A campaign in needs_decision becomes sent when the owner skips the last uncertain
// batch. It never goes from needs_decision to needs_decision, so a decision that leaves
// uncertain batches reports no change.

export interface FinalizeResult {
  /** True when this call changed the status. */
  changed: boolean;
  status: CampaignStatus | null;
}

export async function tryFinalizeCampaign(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  now: number,
): Promise<FinalizeResult> {
  const uncertain = sql`EXISTS (SELECT 1 FROM campaign_batches b WHERE b.workspace_id = ${workspaceId} AND b.campaign_id = ${campaignId} AND b.status = 'uncertain')`;
  const { rows } = await sql<{ status: CampaignStatus }>`
UPDATE campaigns
SET status = CASE WHEN ${uncertain} THEN 'needs_decision' ELSE 'sent' END,
    completed_at = CASE WHEN ${uncertain} THEN completed_at ELSE ${now} END,
    updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${campaignId}
  AND snapshot_done_at IS NOT NULL
  AND (status = 'sending' OR (status = 'needs_decision' AND NOT ${uncertain}))
  AND NOT EXISTS (
    SELECT 1 FROM campaign_batches b
    WHERE b.workspace_id = ${workspaceId} AND b.campaign_id = ${campaignId}
      AND b.status IN ('pending', 'enqueued', 'claimed')
  )
RETURNING status`.execute(db.db);
  const row = rows[0];
  return { changed: row !== undefined, status: row?.status ?? null };
}
