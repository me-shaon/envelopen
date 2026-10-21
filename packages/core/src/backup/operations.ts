import { z } from "zod";
import { OperationError } from "../errors";
import { hasRecentSignIn, type Principal, SESSION_NOT_FRESH } from "../principal";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { ARCHIVE_EXTENSION, archiveLinkKey } from "./archive";
import { MAX_PASSPHRASE_LENGTH, MIN_PASSPHRASE_LENGTH } from "./crypto";
import { startKeyDerivation } from "./derivation";
import {
  BACKUP_MAX_RETENTION_DAYS,
  BACKUP_READ_BUDGET,
  type BackupRunRow,
  type BackupSettingsRow,
  DEFAULT_RETENTION_DAYS,
  decryptS3Destination,
  encryptS3Destination,
  keyMaterialOf,
  nextBackupAt,
  parseDestinations,
  readBackupSettings,
  S3DestinationSchema,
  writeBackupSettings,
} from "./model";
import { RESTORE_ACK_SETTING, readRestoreAck } from "./restore-ack";
import { startBackup } from "./run";

// Backup operations (U4, R1, R2). They are for the owner only: the workspace:admin scope
// is session-only, so API keys cannot hold it, and MCP never lists them. Changes to the
// passphrase, the S3 destination, and the start of a manual backup also need a sign-in
// that completed in the last 10 minutes, as for adding a passkey. A stolen session
// cookie then cannot redirect or rekey the backups.
//
// U5 adds the download link and the acknowledgement of a restored backup. The download
// needs a recent sign-in too. The restore itself runs only from the first-run screen
// (apps/worker/src/setup), never through an operation.

const BACKUP_MCP = {
  class: "never",
  reason:
    "Backups hold all data of the deployment. Only the owner session can manage them, " +
    "and API keys cannot hold the workspace:admin scope.",
} as const;

/** Throws unless the session's sign-in completed in the last 10 minutes. */
function requireRecentSignIn(
  principal: Principal,
  now: number,
  message = "Sign in again to change the backup settings.",
): void {
  if (!hasRecentSignIn(principal, now)) {
    throw new OperationError("forbidden", message, { code: SESSION_NOT_FRESH });
  }
}

/** How long a backup download link works. */
export const BACKUP_LINK_TTL_MS = 15 * 60 * 1000;

const BackupRunSchema = z
  .object({
    id: z.number(),
    backupId: z.string(),
    status: z.enum(["running", "succeeded", "partial", "failed"]),
    trigger: z.enum(["schedule", "manual"]),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    chunkCount: z.number(),
    rowCount: z.number(),
    sizeBytes: z.number(),
    rowsRead: z.number(),
    destinations: z.array(z.string()),
    error: z.string().nullable(),
    s3Error: z.string().nullable(),
    deletedAt: z.number().nullable(),
  })
  .meta({ id: "BackupRun" });

const S3SummarySchema = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  accessKeyId: z.string(),
});

const BackupStatusSchema = z
  .object({
    passphraseSet: z.boolean(),
    keySetAt: z.number().nullable(),
    enabled: z.boolean(),
    retentionDays: z.number(),
    s3: S3SummarySchema.nullable().meta({
      description: "The S3-compatible copy destination. The secret is never returned.",
    }),
    lastRun: BackupRunSchema.nullable(),
    lastSuccess: BackupRunSchema.nullable(),
    nextRunAt: z.number().nullable().meta({ description: "The next daily backup, when enabled." }),
    readBudget: z.number().meta({ description: "D1 rows that backups may read per UTC day." }),
    passphraseDerivation: z
      .object({
        id: z.number(),
        status: z.enum(["pending", "ready", "failed"]),
        error: z.string().nullable(),
        startedAt: z.number(),
        finishedAt: z.number().nullable(),
      })
      .nullable()
      .meta({
        description:
          "The latest passphrase key derivation. It runs in the background for a few " +
          "seconds after the passphrase is set. The passphrase is in use when it is ready.",
      }),
    restore: z
      .object({
        backupId: z.string(),
        backupCreatedAt: z.number(),
        restoredAt: z.number(),
      })
      .nullable()
      .meta({
        description:
          "Set after a restore until the owner confirms the age of the backup. Campaign " +
          "sends wait until then.",
      }),
  })
  .meta({ id: "BackupStatus" });

function runOutput(row: BackupRunRow): z.input<typeof BackupRunSchema> {
  return {
    id: row.id,
    backupId: row.backup_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    chunkCount: row.chunk_count,
    rowCount: row.row_count,
    sizeBytes: row.size_bytes,
    rowsRead: row.rows_read,
    destinations: parseDestinations(row.destinations),
    error: row.error,
    s3Error: row.s3_error,
    deletedAt: row.deleted_at,
  };
}

async function statusOf(
  ctx: OperationContext,
  settings: BackupSettingsRow | null,
): Promise<z.input<typeof BackupStatusSchema>> {
  const { db, now, services } = ctx;
  const lastRun = await db.db
    .selectFrom("backup_runs")
    .selectAll()
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const lastSuccess = await db.db
    .selectFrom("backup_runs")
    .selectAll()
    .where("status", "in", ["succeeded", "partial"])
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  let s3: z.input<typeof S3SummarySchema> | null = null;
  if (settings?.s3_config) {
    const destination = await decryptS3Destination(services.credentials, settings);
    if (destination) {
      s3 = {
        endpoint: destination.endpoint,
        region: destination.region,
        bucket: destination.bucket,
        accessKeyId: destination.accessKeyId,
      };
    }
  }
  const passphraseSet = keyMaterialOf(settings) !== null;
  const derivation = await db.db
    .selectFrom("key_derivations")
    .select(["id", "status", "error", "created_at", "finished_at"])
    .where("purpose", "=", "setup")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const enabled = (settings?.enabled ?? 1) === 1;
  return {
    passphraseSet,
    keySetAt: settings?.key_set_at ?? null,
    enabled,
    retentionDays: settings?.retention_days ?? DEFAULT_RETENTION_DAYS,
    s3,
    lastRun: lastRun ? runOutput(lastRun) : null,
    lastSuccess: lastSuccess ? runOutput(lastSuccess) : null,
    nextRunAt: passphraseSet && enabled ? nextBackupAt(now) : null,
    readBudget: BACKUP_READ_BUDGET,
    passphraseDerivation: derivation
      ? {
          id: derivation.id,
          status: derivation.status,
          error: derivation.error,
          startedAt: derivation.created_at,
          finishedAt: derivation.finished_at,
        }
      : null,
    restore: await readRestoreAck(db),
  };
}

export const backupsGet = defineOperation({
  id: "backups.get",
  summary: "Get the backup status",
  description:
    "Returns the backup settings, the last run, the last successful run, and the time of " +
    "the next daily backup. The S3 secret is never returned.",
  method: "get",
  path: "/backups",
  scope: "workspace:admin",
  risk: "read",
  mcp: BACKUP_MCP,
  input: z.object({}),
  output: BackupStatusSchema,
  async handler(_input, ctx) {
    return statusOf(ctx, await readBackupSettings(ctx.db));
  },
});

export const backupsRuns = defineOperation({
  id: "backups.runs",
  summary: "List the backup runs",
  description: "Lists the most recent backup runs, newest first.",
  method: "get",
  path: "/backups/runs",
  scope: "workspace:admin",
  risk: "read",
  mcp: BACKUP_MCP,
  input: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
  output: z.object({ items: z.array(BackupRunSchema) }),
  async handler(input, { db }) {
    const rows = await db.db
      .selectFrom("backup_runs")
      .selectAll()
      .orderBy("id", "desc")
      .limit(input.limit)
      .execute();
    return { items: rows.map(runOutput) };
  },
});

export const backupsSetPassphrase = defineOperation({
  id: "backups.set_passphrase",
  summary: "Set or change the backup passphrase",
  description:
    "Starts the derivation of the backup key from the passphrase, and returns at once. " +
    "The status shows when the key is ready. Envelopen stores only the public part. " +
    "Envelopen cannot recover a lost passphrase. Backups made before a change still " +
    "need the old passphrase. Needs a sign-in in the last 10 minutes.",
  method: "post",
  path: "/backups/passphrase",
  scope: "workspace:admin",
  risk: "write",
  mcp: BACKUP_MCP,
  input: z.object({
    passphrase: z
      .string()
      .min(
        MIN_PASSPHRASE_LENGTH,
        `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      )
      .max(
        MAX_PASSPHRASE_LENGTH,
        `Use a passphrase of ${MAX_PASSPHRASE_LENGTH} characters or fewer.`,
      ),
  }),
  output: BackupStatusSchema.extend({ changed: z.boolean() }),
  async handler(input, ctx) {
    requireRecentSignIn(ctx.principal, ctx.now);
    const before = await readBackupSettings(ctx.db);
    // PBKDF2 with 600,000 iterations takes about 40 ms of CPU, more than Workers Free
    // gives a request. The key derivation Workflow runs it in steps (derivation.ts).
    await startKeyDerivation(
      ctx.db,
      requireService(ctx.services, "credentials"),
      requireService(ctx.services, "startKeyDerivation"),
      { purpose: "setup", passphrase: input.passphrase },
      ctx.now,
    );
    const status = await statusOf(ctx, await readBackupSettings(ctx.db));
    return { ...status, changed: keyMaterialOf(before) !== null };
  },
  // Never the passphrase: only whether this replaced an earlier one.
  auditTarget: (_input, output) => ({
    targetType: "backup_settings",
    metadata: { passphrase: output.changed ? "changed" : "set" },
  }),
});

const S3InputSchema = S3DestinationSchema.nullable().meta({
  description: "The S3-compatible copy destination. Null removes it. Leave it out to keep it.",
});

export const backupsUpdateSettings = defineOperation({
  id: "backups.update_settings",
  summary: "Update the backup settings",
  description:
    "Turns the daily backup on or off, sets how many days backups are kept, and sets or " +
    "removes the S3-compatible copy destination. Needs a sign-in in the last 10 minutes.",
  method: "patch",
  path: "/backups/settings",
  scope: "workspace:admin",
  risk: "write",
  mcp: BACKUP_MCP,
  input: z.object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(BACKUP_MAX_RETENTION_DAYS).optional(),
    s3: S3InputSchema.optional(),
  }),
  output: BackupStatusSchema,
  async handler(input, ctx) {
    requireRecentSignIn(ctx.principal, ctx.now);
    const change: Parameters<typeof writeBackupSettings>[1] = {};
    if (input.enabled !== undefined) change.enabled = input.enabled ? 1 : 0;
    if (input.retentionDays !== undefined) change.retention_days = input.retentionDays;
    if (input.s3 === null) {
      change.s3_config = null;
      change.s3_key_version = null;
    } else if (input.s3 !== undefined) {
      Object.assign(
        change,
        await encryptS3Destination(requireService(ctx.services, "credentials"), input.s3),
      );
    }
    if (Object.keys(change).length > 0) await writeBackupSettings(ctx.db, change, ctx.now);
    return statusOf(ctx, await readBackupSettings(ctx.db));
  },
  // The S3 destination change is audited without the secret.
  auditTarget: (input) => ({
    targetType: "backup_settings",
    metadata: {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
      ...(input.s3 === undefined
        ? {}
        : input.s3 === null
          ? { s3: "removed" }
          : {
              s3: "set",
              s3Endpoint: new URL(input.s3.endpoint).host,
              s3Bucket: input.s3.bucket,
            }),
    },
  }),
});

export const backupsStart = defineOperation({
  id: "backups.start",
  summary: "Start a backup now",
  description:
    "Starts a backup of all data now. It runs in the background. Needs a backup " +
    "passphrase and a sign-in in the last 10 minutes.",
  method: "post",
  path: "/backups/runs",
  scope: "workspace:admin",
  risk: "write",
  mcp: BACKUP_MCP,
  successStatus: 201,
  input: z.object({}),
  output: BackupRunSchema,
  async handler(_input, ctx) {
    requireRecentSignIn(ctx.principal, ctx.now);
    const run = await startBackup(
      ctx.db,
      requireService(ctx.services, "startBackupJob"),
      "manual",
      ctx.now,
    );
    return runOutput(run);
  },
  auditTarget: (_input, output) => ({ targetType: "backup_run", targetId: output.backupId }),
});

const BackupLinkSchema = z
  .object({
    url: z
      .string()
      .meta({ description: "The download path. It works without a session until it expires." }),
    expiresAt: z.number(),
    filename: z.string(),
    sizeBytes: z.number(),
  })
  .meta({ id: "BackupLink" });

export const backupsDownload = defineOperation({
  id: "backups.download",
  summary: "Get a download link of a backup",
  description:
    "Returns a link to the backup as one encrypted file (.envbak) that works for 15 " +
    "minutes. The first-run screen of a new deployment restores it with the passphrase. " +
    "Needs a sign-in in the last 10 minutes.",
  method: "post",
  path: "/backups/runs/{id}/download",
  scope: "workspace:admin",
  risk: "write",
  mcp: BACKUP_MCP,
  input: z.object({ id: z.coerce.number().int().positive() }),
  output: BackupLinkSchema,
  async handler(input, ctx) {
    requireRecentSignIn(ctx.principal, ctx.now, "Sign in again to download a backup.");
    const run = await ctx.db.db
      .selectFrom("backup_runs")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!run) throw new OperationError("not_found", "No backup has this id.");
    if ((run.status !== "succeeded" && run.status !== "partial") || run.deleted_at !== null) {
      throw new OperationError(
        "conflict",
        "Only a finished backup that is still kept can be downloaded.",
      );
    }
    const expiresAt = ctx.now + BACKUP_LINK_TTL_MS;
    const day = new Date(run.started_at).toISOString().slice(0, 10);
    const filename = `envelopen-backup-${day}-${run.backup_id.slice(0, 8)}${ARCHIVE_EXTENSION}`;
    const url = await requireService(
      ctx.services,
      "signFileLink",
    )({
      key: archiveLinkKey(run.backup_id),
      filename,
      expiresAt,
    });
    return { url, expiresAt, filename, sizeBytes: run.size_bytes };
  },
  // Each download link is an audit event (U4, U5).
  auditTarget: (input) => ({ targetType: "backup_run", targetId: input.id }),
});

export const backupsAcknowledgeRestore = defineOperation({
  id: "backups.acknowledge_restore",
  summary: "Confirm the age of a restored backup",
  description:
    "After a restore, campaign sends wait until the owner confirms the age of the backup, " +
    "because a backup misses the unsubscribes that came after it. Import the provider's " +
    "suppression and unsubscribe lists first. This call lets sends go out again.",
  method: "post",
  path: "/backups/restore/acknowledge",
  scope: "workspace:admin",
  risk: "write",
  mcp: BACKUP_MCP,
  input: z.object({}),
  output: BackupStatusSchema,
  async handler(_input, ctx) {
    await ctx.db.db.deleteFrom("system_settings").where("key", "=", RESTORE_ACK_SETTING).execute();
    return statusOf(ctx, await readBackupSettings(ctx.db));
  },
  auditTarget: () => ({ targetType: "backup_settings", metadata: { restore: "acknowledged" } }),
});
