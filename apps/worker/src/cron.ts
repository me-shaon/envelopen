import {
  applyRetention,
  BACKUP_HOUR,
  BACKUP_MINUTE,
  type BackupJobStarter,
  type CredentialCipher,
  cleanupExpiredFiles,
  expireKeyDerivations,
  expireLeases,
  finalizeIdle,
  isOperationError,
  keyMaterialOf,
  purgeExpiredEvents,
  type RetentionResult,
  readBackupSettings,
  redispatchWaiting,
  repairAllCounts,
  rescueSnapshots,
  resealLegacyConnections,
  resumeAfterPlatformLimit,
  type SweepDeps,
  startBackup,
  startDueCampaigns,
  unappliedProviderEvents,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { purgeExpiredIdempotencyKeys } from "./api/idempotency";
import { type EventSink, eventSink } from "./do/events";
import {
  type DrainReport,
  drainUnsubscribes,
  type LedgerClient,
  unsubscribeLedger,
} from "./do/unsubscribes";
import { usageMeter, usageSink } from "./do/usage";
import { backupStarter, campaignStarter, createServices, sendQueue } from "./services";

// The per-minute cron (U9, KTD19, KTD24). In order:
//
// 1. While the UnsubscribeLedger holds unsubscribes that D1 rejected (KTD1), write them
//    to D1, oldest first, a group per run. While some wait, platform_limit stays: the
//    campaigns resume only after D1 has every unsubscribe.
//    After a D1 daily-limit stop, once 00:00 UTC has passed: resume the campaigns,
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
//    period are deleted (R51). Rollups stay. In the same run, backup key derivations
//    that stopped are failed and their sealed secrets are cleared (U4).
// 6. Once a day, the stored member counts of lists and tags are recounted
//    (lists/counts.ts). Triggers keep them, so the recount normally writes nothing.
// 7. Once a day, backups past their retention period are removed, and the encrypted
//    backup starts (U4). It is skipped when no passphrase is set or backups are off.
//
// Each job runs on its own, so one failure does not stop the others. Every job bounds
// its work, so one run stays inside the Free limits.

export interface CronDeps {
  db: DbConnection;
  sweep: SweepDeps;
  meter: ReturnType<typeof usageMeter>;
  /** The UnsubscribeLedger and the event sink of its drain. */
  unsubscribes: { ledger: LedgerClient; sink: EventSink };
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
  /** The drain of the UnsubscribeLedger, when it ran. */
  unsubscribes: DrainReport | null;
  /** True when platform_limit stays because unsubscribes still wait for D1. */
  held: boolean;
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
    unsubscribes: null,
    held: false,
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

  if (status.unsubscribesPending) {
    await job("drain unsubscribes", async () => {
      report.unsubscribes = await drainUnsubscribes(
        deps.db,
        deps.unsubscribes.ledger,
        deps.unsubscribes.sink,
        sweep.now,
      );
    });
    if (report.limited) return report;
    // A failed drain or a drain with intents left keeps the flag until a later run.
    if (limit && (report.unsubscribes === null || report.unsubscribes.left > 0)) {
      report.held = true;
      return report;
    }
  }

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
    // Backup key derivations that stopped: fail them and clear their sealed secrets.
    await expireKeyDerivations(db, now).catch((error) =>
      console.error("Cron job key derivation expiry failed", error),
    );
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

/** The UTC hour and minute of the daily backup (packages/core/src/backup/model.ts). */
export { BACKUP_HOUR, BACKUP_MINUTE };

function isBackupTime(now: number): boolean {
  const date = new Date(now);
  return date.getUTCHours() === BACKUP_HOUR && date.getUTCMinutes() === BACKUP_MINUTE;
}

export interface BackupCronDeps {
  db: DbConnection;
  bucket: R2Bucket;
  credentials?: CredentialCipher | undefined;
  outboundFetch: typeof fetch;
  startBackupJob: BackupJobStarter;
}

export interface BackupCronReport {
  /** Backup ids that retention removed. */
  removed: string[];
  /** The backup id that started, or null. */
  started: string | null;
  /** Why no backup started, or null. */
  skipped: "no passphrase" | "disabled" | "running" | null;
}

/**
 * The daily backup job. Retention runs first, so a failed start still removes old
 * backups. Retention never removes the newest backup that R2 holds.
 */
export async function runBackupCron(deps: BackupCronDeps, now: number): Promise<BackupCronReport> {
  const report: BackupCronReport = { removed: [], started: null, skipped: null };
  try {
    report.removed = await applyRetention(deps, now);
  } catch (error) {
    console.error("Cron job backup retention failed", error);
  }
  const settings = await readBackupSettings(deps.db);
  if (!keyMaterialOf(settings)) {
    report.skipped = "no passphrase";
    return report;
  }
  if (settings?.enabled === 0) {
    report.skipped = "disabled";
    return report;
  }
  try {
    const run = await startBackup(deps.db, deps.startBackupJob, "schedule", now);
    report.started = run.backup_id;
  } catch (error) {
    if (isOperationError(error) && error.code === "conflict") {
      report.skipped = "running";
      return report;
    }
    throw error;
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
      unsubscribes: { ledger: unsubscribeLedger(env), sink: eventSink(env) },
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
    if (!report.limited && isBackupTime(now)) {
      const services = createServices(env);
      await runBackupCron(
        {
          db,
          bucket: env.BUCKET,
          credentials: services.credentials,
          outboundFetch: services.outboundFetch ?? fetch,
          startBackupJob: backupStarter(env),
        },
        now,
      ).catch((error) => console.error("Cron job daily backup failed", error));
    }
    return report;
  } finally {
    ctx.waitUntil(db.meter.flush().catch((error) => console.error("Usage report failed", error)));
  }
}
