import {
  cleanupExpiredFiles,
  expireLeases,
  finalizeIdle,
  redispatchWaiting,
  rescueSnapshots,
  resumeAfterPlatformLimit,
  type SweepDeps,
  startDueCampaigns,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { purgeExpiredIdempotencyKeys } from "./api/idempotency";
import { usageMeter, usageSink } from "./do/usage";
import { campaignStarter, sendQueue } from "./services";

// The per-minute cron (U9, KTD19, KTD24). In order:
//
// 1. After a D1 daily-limit stop, once 00:00 UTC has passed: resume the campaigns,
//    dispatch every waiting batch again, and clear the platform_limit flag. While the
//    flag is in force, the campaign jobs wait: D1 would reject their writes.
// 2. Start due scheduled campaigns.
// 3. The recovery sweep: restart snapshots that did not finish, expire leases (an
//    uncertain batch, or a retry on an idempotent provider), dispatch waiting and
//    dead-lettered batches again, and finish idle campaigns.
// 4. The existing cleanup: idempotency keys and expired files.
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
    return report;
  } finally {
    ctx.waitUntil(db.meter.flush().catch((error) => console.error("Usage report failed", error)));
  }
}
