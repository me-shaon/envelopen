import type { DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import { chunk } from "../contacts/writes";
import type { BatchPointer, SendQueue } from "../services";

// Dispatch puts batch pointers on the send queue (KTD17). It first writes the new
// state (status `enqueued`, a new generation, the dispatch time), then sends the
// pointers. A pointer of an older generation is stale, so the consumer drops it.
//
// The state is written first, so a lost message never loses a batch: the sweep finds
// a batch that stays enqueued too long and dispatches it again. If the queue call
// fails, the batches go back to `pending` at once, and the caller can try again.

/** One queue call sends at most 100 messages. */
export const DISPATCH_LIMIT = 100;

export interface DispatchOptions {
  /** Pending batches whose `not_before` has passed. Defaults to true. */
  pending?: boolean;
  /** Also enqueued batches dispatched before this time: stale, or dropped while paused. */
  enqueuedBefore?: number;
  /** At most this many batches. Defaults to DISPATCH_LIMIT. */
  limit?: number;
}

/**
 * Dispatches the campaign's ready batches, while the campaign is sending. Returns the
 * pointers that went on the queue.
 */
export async function dispatchBatches(
  db: DbConnection,
  queue: SendQueue,
  workspaceId: number,
  campaignId: number,
  now: number,
  options: DispatchOptions = {},
): Promise<BatchPointer[]> {
  const limit = Math.min(options.limit ?? DISPATCH_LIMIT, DISPATCH_LIMIT);
  const pending = options.pending ?? true;
  const conditions = [
    ...(pending
      ? [sql`(status = 'pending' AND (not_before IS NULL OR not_before <= ${now}))`]
      : []),
    ...(options.enqueuedBefore !== undefined
      ? [
          sql`(status = 'enqueued' AND (dispatched_at IS NULL OR dispatched_at < ${options.enqueuedBefore}))`,
        ]
      : []),
  ];
  if (conditions.length === 0) return [];
  const { rows } = await sql<{ id: number; generation: number }>`
UPDATE campaign_batches
SET status = 'enqueued', generation = generation + 1, dispatched_at = ${now}, not_before = NULL, updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id IN (
  SELECT b.id FROM campaign_batches b
  WHERE b.workspace_id = ${workspaceId} AND b.campaign_id = ${campaignId} AND (${sql.join(conditions, sql` OR `)})
    AND EXISTS (SELECT 1 FROM campaigns c WHERE c.workspace_id = ${workspaceId} AND c.id = ${campaignId} AND c.status = 'sending')
  ORDER BY b.seq LIMIT ${limit}
)
RETURNING id, generation`.execute(db.db);
  if (rows.length === 0) return [];

  const pointers: BatchPointer[] = rows
    .map((row) => ({
      v: 1 as const,
      workspaceId,
      campaignId,
      batchId: row.id,
      generation: row.generation,
    }))
    .sort((a, b) => a.batchId - b.batchId);
  try {
    await queue.send(pointers);
  } catch (error) {
    // Nothing reached the queue: put the batches back, so a retry dispatches them.
    for (const part of chunk(
      pointers.map((pointer) => pointer.batchId),
      90,
    )) {
      await db.db
        .updateTable("campaign_batches")
        .set({ status: "pending", updated_at: now })
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", part)
        .where("status", "=", "enqueued")
        .where("dispatched_at", "=", now)
        .execute();
    }
    throw error;
  }
  return pointers;
}

/** Dispatches every ready batch of the campaign, in rounds of DISPATCH_LIMIT. */
export async function dispatchAll(
  db: DbConnection,
  queue: SendQueue,
  workspaceId: number,
  campaignId: number,
  now: number,
  options: Omit<DispatchOptions, "limit"> & { maxRounds?: number } = {},
): Promise<number> {
  let total = 0;
  for (let round = 0; round < (options.maxRounds ?? 20); round++) {
    const sent = await dispatchBatches(db, queue, workspaceId, campaignId, now, options);
    total += sent.length;
    if (sent.length < DISPATCH_LIMIT) break;
  }
  return total;
}
