import type { BatchStatus, CampaignStatus, DbConnection, RowUpdate } from "@envelopen/db";

// The campaign and batch state machines from the plan's "Campaign and batch states".
// Every status change in the engine is a compare-and-set: an UPDATE whose WHERE clause
// names the status (and, for batches, the generation) that the change starts from.
// Two writers that race for one change therefore cannot both win, and the loser sees
// zero changed rows instead of an error.

/** What causes a campaign transition. */
export type CampaignTrigger =
  | "confirm_schedule"
  | "unschedule"
  | "confirm_send"
  | "start_scheduled"
  | "pause"
  | "resume"
  | "finish_sent"
  | "finish_needs_decision"
  | "decide"
  | "cancel";

const CAMPAIGN_TRANSITIONS: ReadonlyArray<
  readonly [CampaignStatus, CampaignStatus, CampaignTrigger]
> = [
  ["draft", "scheduled", "confirm_schedule"],
  ["scheduled", "draft", "unschedule"],
  ["draft", "sending", "confirm_send"],
  ["scheduled", "sending", "start_scheduled"],
  ["sending", "paused", "pause"],
  ["paused", "sending", "resume"],
  ["sending", "needs_decision", "finish_needs_decision"],
  ["sending", "sent", "finish_sent"],
  // Retry or skip of the last uncertain batch.
  ["needs_decision", "sending", "decide"],
  ["needs_decision", "sent", "decide"],
  ["scheduled", "cancelled", "cancel"],
  ["sending", "cancelled", "cancel"],
  ["paused", "cancelled", "cancel"],
  ["needs_decision", "cancelled", "cancel"],
];

/** The statuses that a trigger can start from. */
export function campaignSources(trigger: CampaignTrigger): CampaignStatus[] {
  return [
    ...new Set(CAMPAIGN_TRANSITIONS.filter(([, , t]) => t === trigger).map(([from]) => from)),
  ];
}

export function canTransitionCampaign(
  from: CampaignStatus,
  to: CampaignStatus,
  trigger?: CampaignTrigger,
): boolean {
  return CAMPAIGN_TRANSITIONS.some(
    ([a, b, t]) => a === from && b === to && (trigger === undefined || t === trigger),
  );
}

/** A campaign whose batches the consumer may send. Paused and cancelled campaigns drop messages. */
export function isSendingStatus(status: CampaignStatus): boolean {
  return status === "sending";
}

/** Campaigns in these statuses can still change. */
export function isActiveCampaign(status: CampaignStatus): boolean {
  return (
    status === "scheduled" ||
    status === "sending" ||
    status === "paused" ||
    status === "needs_decision"
  );
}

/** What causes a batch transition. */
export type BatchTrigger =
  | "dispatch"
  | "redispatch"
  | "claim"
  | "done"
  | "return"
  | "lease_expired"
  | "idempotent_retry"
  | "owner_retry"
  | "owner_skip";

const BATCH_TRANSITIONS: ReadonlyArray<readonly [BatchStatus, BatchStatus, BatchTrigger]> = [
  ["pending", "enqueued", "dispatch"],
  // A stale enqueued batch, or one whose message reached the dead-letter queue, gets a new generation.
  ["enqueued", "enqueued", "redispatch"],
  ["enqueued", "claimed", "claim"],
  ["claimed", "done", "done"],
  // Results that arrive after the sweep marked the batch uncertain still count.
  ["uncertain", "done", "done"],
  // A provider refusal (429, credits, quota) after the claim: nothing went out.
  ["claimed", "pending", "return"],
  ["claimed", "uncertain", "lease_expired"],
  // An idempotent provider retries the frozen payload with the stored key.
  ["claimed", "enqueued", "idempotent_retry"],
  ["uncertain", "pending", "owner_retry"],
  ["uncertain", "skipped", "owner_skip"],
];

export function canTransitionBatch(
  from: BatchStatus,
  to: BatchStatus,
  trigger?: BatchTrigger,
): boolean {
  return BATCH_TRANSITIONS.some(
    ([a, b, t]) => a === from && b === to && (trigger === undefined || t === trigger),
  );
}

/** Batches that still have work: a campaign is not finished while one of them exists. */
export const OPEN_BATCH_STATUSES: readonly BatchStatus[] = ["pending", "enqueued", "claimed"];

/**
 * Moves a campaign from one of `from` to `to`, and applies `set` in the same statement.
 * Returns true when this call made the change.
 */
export async function transitionCampaign(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  from: readonly CampaignStatus[],
  to: CampaignStatus,
  now: number,
  set: Omit<RowUpdate<"campaigns">, "status" | "updated_at"> = {},
): Promise<boolean> {
  const result = await db.db
    .updateTable("campaigns")
    .set({ ...set, status: to, updated_at: now })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", campaignId)
    .where("status", "in", [...from])
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
