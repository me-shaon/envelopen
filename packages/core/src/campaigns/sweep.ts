import { type DbConnection, unscoped } from "@envelopen/db";
import { getAdapter } from "@envelopen/providers";
import { sql } from "kysely";
import type { BatchPointer, CampaignJob, SendQueue } from "../services";
import { dispatchAll } from "./dispatch";
import { tryFinalizeCampaign } from "./finalize";
import { ENQUEUE_TIMEOUT_MS, IDEMPOTENT_ATTEMPT_LIMIT } from "./model";
import { transitionCampaign } from "./state-machine";

// The per-minute recovery sweep (KTD19). The cron in apps/worker/src/cron.ts runs these
// jobs in order. Each one finds its work across workspaces with a bounded query
// (`unscoped`, a deliberate cross-workspace read), then changes each item with a
// compare-and-set in its own workspace. Every job is safe to run twice, and safe to run
// next to the consumer.

export interface SweepDeps {
  db: DbConnection;
  queue: SendQueue;
  startCampaignJob(job: CampaignJob): Promise<void>;
  now: number;
}

/** Due scheduled campaigns become sending, and their snapshot Workflow starts. */
export async function startDueCampaigns(deps: SweepDeps, limit = 10): Promise<number[]> {
  const due = await unscoped(deps.db.db)
    .selectFrom("campaigns")
    .select(["id", "workspace_id"])
    .where("status", "=", "scheduled")
    .where("scheduled_at", "<=", deps.now)
    .orderBy("scheduled_at", "asc")
    .limit(limit)
    .execute();
  const started: number[] = [];
  for (const row of due) {
    const changed = await transitionCampaign(
      deps.db,
      row.workspace_id,
      row.id,
      ["scheduled"],
      "sending",
      deps.now,
      {
        started_at: deps.now,
      },
    );
    if (!changed) continue;
    await deps.startCampaignJob({
      workspaceId: row.workspace_id,
      campaignId: row.id,
      startedAt: deps.now,
    });
    started.push(row.id);
  }
  return started;
}

/**
 * A sending campaign whose snapshot has not finished long after the start: the
 * Workflow may have failed to start. Starting it again is safe (snapshot.ts).
 */
export async function rescueSnapshots(deps: SweepDeps, limit = 5, afterMs = 10 * 60 * 1000) {
  const rows = await unscoped(deps.db.db)
    .selectFrom("campaigns")
    .select(["id", "workspace_id", "started_at"])
    .where("status", "=", "sending")
    .where("snapshot_done_at", "is", null)
    .where("started_at", "<", deps.now - afterMs)
    .limit(limit)
    .execute();
  for (const row of rows) {
    await deps.startCampaignJob({
      workspaceId: row.workspace_id,
      campaignId: row.id,
      startedAt: row.started_at ?? deps.now,
    });
  }
  return rows.map((row) => row.id);
}

export interface LeaseReport {
  uncertain: number[];
  retried: number[];
}

/**
 * Claimed batches whose lease expired (R38, R70, AE3). A non-idempotent provider may
 * have sent them, so they become uncertain and wait for the owner. An idempotent
 * provider gets a retry pointer: the consumer resends the frozen payload with the
 * stored key, until the provider's key window or the attempt limit runs out.
 */
export async function expireLeases(deps: SweepDeps, limit = 50): Promise<LeaseReport> {
  const rows = await unscoped(deps.db.db)
    .selectFrom("campaign_batches as b")
    .innerJoin("campaigns as c", "c.id", "b.campaign_id")
    .leftJoin("provider_connections as pc", "pc.id", "c.connection_id")
    .select([
      "b.id",
      "b.workspace_id",
      "b.campaign_id",
      "b.attempts",
      "b.first_claimed_at",
      "b.idempotency_key",
      "c.status as campaign_status",
      "pc.provider",
    ])
    .where("b.status", "=", "claimed")
    .where("b.lease_until", "<", deps.now)
    .limit(limit)
    .execute();

  const report: LeaseReport = { uncertain: [], retried: [] };
  const pointers: BatchPointer[] = [];
  for (const row of rows) {
    const capabilities = row.provider ? getAdapter(row.provider)?.capabilities : undefined;
    const window = capabilities?.idempotencyWindowMs ?? 0;
    const retry =
      capabilities?.idempotency === true &&
      row.idempotency_key !== null &&
      row.first_claimed_at !== null &&
      row.first_claimed_at + window > deps.now &&
      row.attempts < IDEMPOTENT_ATTEMPT_LIMIT;
    if (retry) {
      const { rows: updated } = await sql<{ generation: number }>`
UPDATE campaign_batches SET status = 'enqueued', generation = generation + 1, lease_until = NULL,
  dispatched_at = ${deps.now}, updated_at = ${deps.now}
WHERE workspace_id = ${row.workspace_id} AND id = ${row.id} AND status = 'claimed' AND lease_until < ${deps.now}
RETURNING generation`.execute(deps.db.db);
      const generation = updated[0]?.generation;
      if (generation === undefined) continue;
      report.retried.push(row.id);
      // A paused campaign keeps the batch enqueued. Resume dispatches it again.
      if (row.campaign_status === "sending") {
        pointers.push({
          v: 1,
          workspaceId: row.workspace_id,
          campaignId: row.campaign_id,
          batchId: row.id,
          generation,
        });
      }
      continue;
    }
    const result = await deps.db.db
      .updateTable("campaign_batches")
      .set({
        status: "uncertain",
        uncertain_at: deps.now,
        lease_until: null,
        last_error: "The provider did not confirm the send before the lease expired.",
        updated_at: deps.now,
      })
      .where("workspace_id", "=", row.workspace_id)
      .where("id", "=", row.id)
      .where("status", "=", "claimed")
      .where("lease_until", "<", deps.now)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) report.uncertain.push(row.id);
  }
  // If this send fails, the batches stay enqueued, and the stale pass below sends them later.
  if (pointers.length > 0) await deps.queue.send(pointers);
  return report;
}

/**
 * Batches of sending campaigns that wait: pending ones whose wait is over, and
 * enqueued ones whose message is lost, for example in the dead-letter queue (KTD19).
 * Each gets a new generation, so an old message that still arrives is dropped.
 */
export async function redispatchWaiting(deps: SweepDeps, limit = 10): Promise<number> {
  const staleBefore = deps.now - ENQUEUE_TIMEOUT_MS;
  const campaigns = await unscoped(deps.db.db)
    .selectFrom("campaign_batches as b")
    .innerJoin("campaigns as c", "c.id", "b.campaign_id")
    .select(["b.workspace_id", "b.campaign_id"])
    .distinct()
    .where("c.status", "=", "sending")
    .where((eb) =>
      eb.or([
        eb.and([eb("b.status", "=", "enqueued"), eb("b.dispatched_at", "<", staleBefore)]),
        eb.and([
          eb("b.status", "=", "pending"),
          eb.or([eb("b.not_before", "is", null), eb("b.not_before", "<=", deps.now)]),
          eb("c.snapshot_done_at", "is not", null),
        ]),
      ]),
    )
    .limit(limit)
    .execute();
  let total = 0;
  for (const row of campaigns) {
    total += await dispatchAll(deps.db, deps.queue, row.workspace_id, row.campaign_id, deps.now, {
      enqueuedBefore: staleBefore,
      maxRounds: 3,
    });
  }
  return total;
}

/** Sending campaigns with no open batch finish (KTD19). */
export async function finalizeIdle(deps: SweepDeps, limit = 20) {
  const rows = await unscoped(deps.db.db)
    .selectFrom("campaigns as c")
    .select(["c.id", "c.workspace_id"])
    .where("c.status", "=", "sending")
    .where("c.snapshot_done_at", "is not", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("campaign_batches as b")
            .select("b.id")
            .whereRef("b.campaign_id", "=", "c.id")
            .where("b.status", "in", ["pending", "enqueued", "claimed"]),
        ),
      ),
    )
    .limit(limit)
    .execute();
  const finished: { id: number; status: string }[] = [];
  for (const row of rows) {
    const result = await tryFinalizeCampaign(deps.db, row.workspace_id, row.id, deps.now);
    if (result.changed && result.status) {
      finished.push({ id: row.id, status: result.status });
      await systemAudit(deps.db, row.workspace_id, row.id, `campaigns.${result.status}`, {
        by: "sweep",
      });
    }
  }
  return finished;
}

/**
 * After 00:00 UTC, campaigns that the D1 daily limit stopped go on (R39, AE4). The
 * consumer dropped their messages while the UsageMeter flag was set, so every waiting
 * batch is dispatched again. The pause and the resume go to the audit log, because D1
 * could not take the pause when it happened.
 */
export async function resumeAfterPlatformLimit(
  deps: SweepDeps,
  limit: { since: number; until: number },
  max = 50,
): Promise<number[]> {
  // A pause that reached D1 (for example from a Workflow step) resumes as well.
  const paused = await unscoped(deps.db.db)
    .selectFrom("campaigns")
    .select(["id", "workspace_id"])
    .where("status", "=", "paused")
    .where("pause_reason", "=", "platform_limit")
    .limit(max)
    .execute();
  for (const row of paused) {
    await transitionCampaign(deps.db, row.workspace_id, row.id, ["paused"], "sending", deps.now, {
      pause_reason: null,
      pause_detail: null,
      resume_at: null,
    });
  }
  const sending = await unscoped(deps.db.db)
    .selectFrom("campaigns")
    .select(["id", "workspace_id"])
    .where("status", "=", "sending")
    .limit(max)
    .execute();
  for (const row of sending) {
    await systemAudit(deps.db, row.workspace_id, row.id, "campaigns.paused", {
      reason: "platform_limit",
      at: limit.since,
    });
    await dispatchAll(deps.db, deps.queue, row.workspace_id, row.id, deps.now, {
      enqueuedBefore: deps.now,
    });
    await systemAudit(deps.db, row.workspace_id, row.id, "campaigns.resumed", {
      reason: "platform_limit",
      resetAt: limit.until,
    });
  }
  return sending.map((row) => row.id);
}

/** An audit row for a change that the system made, not a person or a key. */
export async function systemAudit(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.db
    .insertInto("audit_log")
    .values({
      workspace_id: workspaceId,
      actor_type: "system",
      actor_id: null,
      surface: "system",
      api_key_id: null,
      action,
      target_type: "campaign",
      target_id: String(campaignId),
      metadata: JSON.stringify(metadata),
      ip: null,
    })
    .execute();
}
