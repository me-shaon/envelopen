import {
  cleanupExpiredFiles,
  expireLeases,
  finalizeIdle,
  purgeExpiredEvents,
  type RetentionResult,
  redispatchWaiting,
  repairAllCounts,
  rescueSnapshots,
  resealLegacyConnections,
  resumeAfterPlatformLimit,
  type SweepDeps,
  startDueCampaigns,
  unappliedProviderEvents,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { purgeExpiredIdempotencyKeys } from "./api/idempotency";
import { type EventSink, eventSink } from "./do/events";
import { usageMeter, usageSink } from "./do/usage";
import { campaignStarter, createServices, sendQueue } from "./services";

// The per-minute cron (U9, KTD19, KTD24). In order:
//
// 1. After a D1 daily-limit stop, once 00:00 UTC has passed: resume the campaigns,
//    dispatch every waiting batch again, and clear the platform_limit flag. While the
//    flag is in force, the campaign jobs wait: D1 would reject their writes.
// 2. Start due scheduled campaigns.
// 3. The recovery sweep: restart snapshots that did not finish, expire leases (an
//    uncertain batch, or a retry on an idempotent provider), dispatch waiting and
//    dead-lettered batches again, and finish idle campaigns.
// 4. The existing cleanup: idempotency keys and expired files. Then provider secrets
//    from before the connection-bound format are encrypted again (a few per run).
// 5. The event pipeline (U10): provider events that no flush applied go to their
//    EventBuffer again, and once an hour raw events past the workspace's retention
//    period are deleted (R51). Rollups stay.
// 6. Once a day, the stored member counts of lists and tags are recounted
//    (lists/counts.ts). Triggers keep them, so the recount normally writes nothing.
//
// Each job runs on its own, so one failure does not stop the others. Every job bounds
// its work, so one run stays inside the Free limits.

export interface CronDeps {
  db: DbConnection;
  sweep: SweepDeps;
  meter: ReturnType<typeof usageMeter>;
}

export interface CronReport {
  resumed: number[];
  started: number[];
  rescued: number[];
  uncertain: number[];
  retried: number[];
  redispatched: number;
  finished: { id: number; status: string }[];
  limited: boolean;
}

export async function runCampaignCron(deps: CronDeps): Promise<CronReport> {
  const report: CronReport = {
    resumed: [],
    started: [],
    rescued: [],
    uncertain: [],
    retried: [],
    redispatched: 0,
    finished: [],
    limited: false,
  };
  const { sweep, meter } = deps;
  const status = await meter.status(sweep.now);
  const limit = status.platformLimit;
  if (limit && limit.until > sweep.now) {
    report.limited = true;
    return report;
  }

  const job = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (isD1DailyLimitError(error)) {
        report.limited = true;
        await meter.setPlatformLimit(sweep.now, nextUtcMidnight(sweep.now));
        return;
      }
      console.error(`Cron job ${name} failed`, error);
    }
  };

  if (limit) {
    await job("resume after the daily limit", async () => {
      report.resumed = await resumeAfterPlatformLimit(sweep, limit);
      await meter.clearPlatformLimit();
    });
  }
  const steps: [string, () => Promise<void>][] = [
    [
      "start scheduled",
      async () => {
        report.started = await startDueCampaigns(sweep);
      },
    ],
    [
      "rescue snapshots",
      async () => {
        report.rescued = await rescueSnapshots(sweep);
      },
    ],
    [
      "expire leases",
      async () => {
        const leases = await expireLeases(sweep);
        report.uncertain = leases.uncertain;
        report.retried = leases.retried;
      },
    ],
    [
      "dispatch waiting",
      async () => {
        report.redispatched = await redispatchWaiting(sweep);
      },
    ],
    [
      "finish idle",
      async () => {
        report.finished = await finalizeIdle(sweep);
      },
    ],
  ];
  for (const [name, work] of steps) {
    if (report.limited) break;
    await job(name, work);
  }
  return report;
}

/** A provider event waits this long for its flush before the cron hands it over again. */
export const RESCUE_AFTER_MS = 5 * 60 * 1000;
/** The minute of each hour when the retention job runs. */
export const RETENTION_MINUTE = 17;

export interface EventCronReport {
  rescued: number;
  retention: RetentionResult | null;
}

/** The event pipeline jobs of the cron. Each runs on its own. */
export async function runEventCron(
  db: DbConnection,
  sink: EventSink,
  now: number,
): Promise<EventCronReport> {
  const report: EventCronReport = { rescued: 0, retention: null };
  try {
    const waiting = await unappliedProviderEvents(db, now, RESCUE_AFTER_MS);
    for (const [workspaceId, events] of waiting) {
      await sink(workspaceId, events);
      report.rescued += events.length;
    }
  } catch (error) {
    console.error("Cron job rescue provider events failed", error);
  }
  if (new Date(now).getUTCMinutes() === RETENTION_MINUTE) {
    try {
      report.retention = await purgeExpiredEvents(db, now);
    } catch (error) {
      console.error("Cron job event retention failed", error);
    }
  }
  return report;
}

/** The UTC hour and minute of the daily recount of list and tag member counts. */
export const RECOUNT_HOUR = 3;
export const RECOUNT_MINUTE = 41;

function isRecountTime(now: number): boolean {
  const date = new Date(now);
  return date.getUTCHours() === RECOUNT_HOUR && date.getUTCMinutes() === RECOUNT_MINUTE;
}

/** The `scheduled()` handler. */
export async function runCron(
  env: Env,
  ctx: ExecutionContext,
  now = Date.now(),
): Promise<CronReport> {
  const db = createDb(env, { usageSink: usageSink(env) });
  try {
    const report = await runCampaignCron({
      db,
      meter: usageMeter(env),
      sweep: { db, queue: sendQueue(env), startCampaignJob: campaignStarter(env), now },
    });
    await purgeExpiredIdempotencyKeys(db);
    // Uploads, error files, and exports that hold contact data expire after 24 hours.
    await cleanupExpiredFiles(db, env.BUCKET);
    // Provider secrets from before v2 ciphertexts get bound to their connection id.
    await resealLegacyConnections(db, createServices(env)).catch((error) =>
      console.error("Cron job reseal connections failed", error),
    );
    if (!report.limited) await runEventCron(db, eventSink(env), now);
    if (!report.limited && isRecountTime(now)) {
      await repairAllCounts(db).catch((error) =>
        console.error("Cron job recount of member counts failed", error),
      );
    }
    return report;
  } finally {
    ctx.waitUntil(db.meter.flush().catch((error) => console.error("Usage report failed", error)));
  }
}
