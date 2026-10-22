import type { DbConnection } from "@envelopen/db";
import { batchSizeFor, getAdapter } from "@envelopen/providers";
import { sql } from "kysely";
import type { DailyCounter } from "../connections/daily-cap";
import type { CampaignJob, SendQueue } from "../services";
import { readWorkersPlan } from "../settings/operations";
import {
  type AudienceCounts,
  exclusionCountsOf,
  insertPageRecipientsQuery,
  pageExclusionsQuery,
} from "./audience";
import { assignNewBatches, beginSendWindows, cappedBatchSize } from "./caps";
import { dispatchAll } from "./dispatch";
import { type FinalizeResult, tryFinalizeCampaign } from "./finalize";
import {
  campaignAudience,
  EXCLUSION_REASONS,
  type ExclusionCounts,
  emptyExclusions,
  SNAPSHOT_PAGE_CONTACTS,
} from "./model";
import { transitionCampaign } from "./state-machine";

// The recipient snapshot (R36, KTD22). The campaign Workflow
// (apps/worker/src/workflows/campaign-workflow.ts) runs it as steps:
//
// 1. `beginSnapshot` fixes the stable cut: the highest contact id of the workspace at
//    the start. A contact imported later has a higher id and never joins (KTD22).
// 2. `snapshotPage` takes the next SNAPSHOT_PAGE_CONTACTS contacts by id. One D1 batch
//    inserts the recipients with INSERT ... SELECT, groups the new recipients into
//    batches of the adapter's size, and records each recipient's batch. Then it
//    dispatches the new batches, so sending starts while the snapshot goes on.
// 3. `finishSnapshot` stores the totals and lets the campaign finish.
//
// With a daily cap on the connection (U19), `beginSnapshot` fixes window 0, and each
// page puts its new batches in 24-hour windows before it dispatches (caps.ts). A batch
// of a later window waits in `pending` until its window starts.
//
// The work is set-based, so the Worker spends almost no CPU per page, and every page is
// safe to repeat: the unique (campaign, contact) key skips recipients that exist, and
// only recipients without a batch get one.

export type SnapshotStart =
  | { state: "run"; cut: number; batchSize: number }
  | { state: "stop"; reason: string };

export type PageOutcome =
  | {
      kind: "page";
      nextAfterId: number;
      done: boolean;
      recipients: number;
      excluded: ExclusionCounts;
      dispatched: number;
    }
  | { kind: "stop"; reason: string };

async function campaignState(db: DbConnection, job: CampaignJob) {
  return db.db
    .selectFrom("campaigns")
    .leftJoin("provider_connections as pc", (join) =>
      join
        .onRef("pc.id", "=", "campaigns.connection_id")
        .on("pc.workspace_id", "=", job.workspaceId),
    )
    .select([
      "campaigns.status",
      "campaigns.type",
      "campaigns.audience",
      "campaigns.parent_id",
      "campaigns.snapshot_max_contact_id",
      "campaigns.snapshot_done_at",
      "pc.provider",
    ])
    .where("campaigns.workspace_id", "=", job.workspaceId)
    .where("campaigns.id", "=", job.campaignId)
    .executeTakeFirst();
}

/** A snapshot runs while the campaign sends or is paused. A cancel stops it. */
function snapshotStops(status: string | undefined): string | null {
  if (status === undefined) return "The campaign no longer exists.";
  if (status !== "sending" && status !== "paused") return `The campaign is ${status}.`;
  return null;
}

export async function beginSnapshot(
  db: DbConnection,
  job: CampaignJob,
  counter?: Pick<DailyCounter, "used">,
  now = Date.now(),
): Promise<SnapshotStart> {
  const state = await campaignState(db, job);
  const stop = snapshotStops(state?.status);
  if (stop || !state) return { state: "stop", reason: stop ?? "Missing campaign." };
  if (state.snapshot_done_at !== null) return { state: "stop", reason: "The snapshot is done." };
  const adapter = state.provider ? getAdapter(state.provider) : undefined;
  if (!adapter) {
    // The connection was removed after confirm. The owner fixes it and resumes.
    await transitionCampaign(
      db,
      job.workspaceId,
      job.campaignId,
      ["sending"],
      "paused",
      Date.now(),
      {
        pause_reason: "manual",
        pause_detail:
          "The provider connection of this campaign is gone. Select a connection, then resume.",
        paused_at: Date.now(),
      },
    );
    return { state: "stop", reason: "The campaign has no usable connection." };
  }

  // The first run fixes the cut. A repeated run keeps it.
  await sql`
UPDATE campaigns SET snapshot_max_contact_id = (
  SELECT COALESCE(MAX(id), 0) FROM contacts WHERE workspace_id = ${job.workspaceId}
)
WHERE workspace_id = ${job.workspaceId} AND id = ${job.campaignId} AND snapshot_max_contact_id IS NULL`.execute(
    db.db,
  );
  const fixed = await campaignState(db, job);
  const cap = await beginSendWindows(db, counter, job.workspaceId, job.campaignId, now);
  return {
    state: "run",
    cut: fixed?.snapshot_max_contact_id ?? 0,
    // SMTP sends smaller batches on Workers Free (Trial 1 of U17). The plan is the owner's
    // setting. No batch is larger than the daily cap.
    batchSize: cappedBatchSize(batchSizeFor(adapter, await readWorkersPlan(db)), cap),
  };
}

export async function snapshotPage(
  db: DbConnection,
  queue: SendQueue,
  job: CampaignJob,
  page: { afterId: number; cut: number; batchSize: number; pageSize?: number },
  now: number,
): Promise<PageOutcome> {
  const state = await campaignState(db, job);
  const stop = snapshotStops(state?.status);
  if (stop || !state) return { kind: "stop", reason: stop ?? "Missing campaign." };
  const { workspaceId, campaignId } = job;
  const audience = campaignAudience(state);
  const pageSize = page.pageSize ?? SNAPSHOT_PAGE_CONTACTS;

  // The upper contact id of this page, and the next batch number.
  const [last, seq] = await Promise.all([
    db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("id", ">", page.afterId)
      .where("id", "<=", page.cut)
      .orderBy("id", "asc")
      .limit(1)
      .offset(pageSize - 1)
      .executeTakeFirst(),
    db.db
      .selectFrom("campaign_batches")
      .select((eb) => eb.fn.max<number | null>("seq").as("max"))
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst(),
  ]);
  const toId = last?.id ?? page.cut;
  const done = last === undefined || toId >= page.cut;
  // Inlined as integer literals: D1 binds JavaScript numbers as REAL, and the batch
  // number must come from integer division.
  const base = Math.trunc(Number(seq?.max ?? 0)) + 1;
  const size = Math.max(1, Math.trunc(page.batchSize));

  const results = await db.atomic<AudienceCounts>([
    pageExclusionsQuery(db.db, workspaceId, audience, state.type, page.afterId, toId),
    insertPageRecipientsQuery(
      db.db,
      workspaceId,
      campaignId,
      audience,
      state.type,
      page.afterId,
      toId,
    ),
    sql`
INSERT INTO campaign_batches (workspace_id, campaign_id, seq, recipient_count, updated_at)
SELECT ${workspaceId}, ${campaignId}, ${sql.lit(base)} + grp, count(*), ${now} FROM (
  SELECT (row_number() OVER (ORDER BY id) - 1) / ${sql.lit(size)} AS grp
  FROM campaign_recipients
  WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId} AND batch_id IS NULL
) GROUP BY grp`.compile(db.db),
    sql`
UPDATE campaign_recipients SET batch_id = v.bid FROM (
  SELECT r.rid, b.id AS bid FROM (
    SELECT id AS rid, (row_number() OVER (ORDER BY id) - 1) / ${sql.lit(size)} AS grp
    FROM campaign_recipients
    WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId} AND batch_id IS NULL
  ) r
  JOIN campaign_batches b ON b.workspace_id = ${workspaceId} AND b.campaign_id = ${campaignId} AND b.seq = ${sql.lit(base)} + r.grp
) v
WHERE campaign_recipients.workspace_id = ${workspaceId} AND campaign_recipients.id = v.rid`.compile(
      db.db,
    ),
  ]);
  const excluded = exclusionCountsOf(results[0]?.results ?? []);
  const recipients = results[1]?.meta.changes ?? 0;
  await assignNewBatches(db, workspaceId, campaignId, now);

  // Sending starts while the snapshot goes on. A paused campaign dispatches at resume.
  const dispatched = await dispatchAll(db, queue, workspaceId, campaignId, now);
  return { kind: "page", nextAfterId: toId, done, recipients, excluded, dispatched };
}

export function addExclusions(a: ExclusionCounts, b: ExclusionCounts): ExclusionCounts {
  const sum = emptyExclusions();
  for (const reason of EXCLUSION_REASONS) sum[reason] = a[reason] + b[reason];
  return sum;
}

/**
 * Stores the totals and marks the snapshot done. The campaign can then finish.
 *
 * Each page puts every new recipient in a batch in the same D1 batch as the insert, and
 * a batch's recipient_count never changes. So the sum over the batches is the number of
 * recipients, at one row read per batch instead of one per recipient.
 */
export async function finishSnapshot(
  db: DbConnection,
  job: CampaignJob,
  excluded: ExclusionCounts,
  now: number,
): Promise<FinalizeResult> {
  const { workspaceId, campaignId } = job;
  await sql`
UPDATE campaigns SET
  snapshot_done_at = COALESCE(snapshot_done_at, ${now}),
  recipient_count = (SELECT COALESCE(SUM(recipient_count), 0) FROM campaign_batches WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId}),
  exclusions = ${JSON.stringify(excluded)},
  updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${campaignId}`.execute(db.db);
  return tryFinalizeCampaign(db, workspaceId, campaignId, now);
}
