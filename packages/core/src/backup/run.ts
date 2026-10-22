import { type DbConnection, nextUtcMidnight, TABLE_SCOPE, type TableName } from "@envelopen/db";
import { sql } from "kysely";
import { utcDay } from "../campaigns/batch";
import type { CredentialCipher } from "../crypto/credentials";
import { OperationError } from "../errors";
import type { BackupJob } from "../services";
import { SUPPRESSION_KEY_SETTING } from "../suppression/hash";
import {
  type BackupKeyMaterial,
  type DeploymentSecrets,
  encryptChunk,
  generateDataKey,
  openDataKey,
  sealDataKey,
  type WrappedKey,
  wrapForRecipient,
} from "./crypto";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_SCHEMA_VERSION,
  BACKUP_TABLES,
  backupPrefix,
  CHUNK_ROWS,
  CHUNK_ROWS_BY_TABLE,
  chunkKey,
  encodeRows,
  MANIFEST_KEY,
  type ManifestBody,
  type ManifestChunk,
  type ManifestTable,
  sha256Base64Url,
  signManifest,
} from "./format";
import {
  activeRun,
  BACKUP_READ_BUDGET,
  type BackupRunRow,
  decryptS3Destination,
  keyMaterialOf,
  parseDestinations,
  readBackupSettings,
  rowsReadOnDay,
} from "./model";
import { type BackupStore, listR2Keys, r2Store, S3Error, s3Store } from "./storage";

// The backup engine (U4, KTD2). The backup Workflow
// (apps/worker/src/workflows/backup-workflow.ts) runs each function below as one step,
// through `driveBackup`. Tests run the same driver without a Workflow.
//
// 1. begin: records the highest rowid of every table, makes a random data key, wraps it
//    and the deployment secrets to the passphrase's public key, and seals the data key
//    for the Workflow state.
// 2. chunk: reads up to CHUNK_ROWS rows of one table by rowid, up to the mark, encrypts
//    them, and stores the chunk in R2, then in S3 when it is set. Before the read, it
//    checks the daily read budget over all runs. When the budget is spent, the run
//    sleeps until after 00:00 UTC.
// 3. finish: writes the signed manifest, then marks the run succeeded, or partial when
//    the S3 copy failed.
//
// Each chunk step writes one row (the run's progress), so the D1 writes stay small.

/** A chunk of NDJSON stops at this size, so one S3 PUT and the Worker memory stay small. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** The rows that one chunk step reads at most, for the budget check. */
const CHUNK_READ_ESTIMATE = CHUNK_ROWS + 10;
/** Wait a little past 00:00 UTC before the run reads again. */
export const RESET_MARGIN_MS = 5 * 60 * 1000;
/**
 * Workflows allow 1,024 steps per instance on Workers Free. Each chunk and each sleep is
 * one step, so a backup holds at most about 1,000,000 rows.
 */
export const MAX_BACKUP_STEPS = 1_000;

/** The deployment secrets from the Worker's env (R3). */
export interface BackupEnvSecrets {
  signingKey?: string | undefined;
  signingKeysRetired?: string | undefined;
  encryptionKey?: string | undefined;
}

export interface BackupDeps {
  db: DbConnection;
  bucket: R2Bucket;
  /** Decrypts the S3 destination. */
  credentials?: CredentialCipher | undefined;
  outboundFetch: typeof fetch;
  secrets: BackupEnvSecrets;
  now: number;
  /** D1 rows that backups may read per UTC day. Defaults to BACKUP_READ_BUDGET. */
  readBudget?: number;
}

export interface StartTable {
  name: TableName;
  /** The highest rowid at the start, or null for an empty table. */
  mark: number | null;
}

export type BackupStart =
  | { kind: "stop"; reason: string }
  | {
      kind: "ready";
      createdAt: number;
      keyMaterial: BackupKeyMaterial;
      wrappedKey: WrappedKey;
      /** The data key, sealed with ENCRYPTION_KEY (crypto.ts sealDataKey). */
      sealedKey: string;
      tables: StartTable[];
      /** True when an S3 copy is set. */
      s3: boolean;
    };
export type ReadyStart = Extract<BackupStart, { kind: "ready" }>;

export interface ChunkCursor {
  table: number;
  afterRowid: number;
  index: number;
  /** After a budget sleep: the time the run waited for. */
  notBefore: number;
  /** True when no S3 copy is set or an S3 upload failed. */
  skipS3: boolean;
}

export type ChunkOutcome =
  | { kind: "budget"; resumeAt: number }
  | {
      kind: "chunk";
      chunk: ManifestChunk | null;
      next: { table: number; afterRowid: number };
      s3Error: string | null;
    };

export interface FinishOutcome {
  status: "succeeded" | "partial";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error.";
}

async function runRow(db: DbConnection, runId: number): Promise<BackupRunRow | undefined> {
  return db.db.selectFrom("backup_runs").selectAll().where("id", "=", runId).executeTakeFirst();
}

/** The run row change that adds D1 rows read on a UTC day. */
function readMeter(rowsRead: number, day: string) {
  return {
    rows_read: sql<number>`rows_read + ${rowsRead}`,
    rows_read_day: sql<number>`CASE WHEN read_day = ${day} THEN rows_read_day + ${rowsRead} ELSE ${rowsRead} END`,
    read_day: day,
  };
}

async function addReads(db: DbConnection, runId: number, rowsRead: number, day: string) {
  await db.db
    .updateTable("backup_runs")
    .set(readMeter(rowsRead, day))
    .where("id", "=", runId)
    .execute();
}

/** Marks the run failed. */
export async function failBackup(deps: BackupDeps, job: BackupJob, error: string): Promise<void> {
  await deps.db.db
    .updateTable("backup_runs")
    .set({ status: "failed", finished_at: deps.now, error: error.slice(0, 500) })
    .where("id", "=", job.runId)
    .where("status", "=", "running")
    .execute();
}

async function suppressionKeyId(db: DbConnection): Promise<string | null> {
  const row = await db.db
    .selectFrom("system_settings")
    .select("value")
    .where("key", "=", SUPPRESSION_KEY_SETTING)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** Step 1: the high-water marks and the keys. */
export async function beginBackup(deps: BackupDeps, job: BackupJob): Promise<BackupStart> {
  const { db, now } = deps;
  const run = await runRow(db, job.runId);
  if (run?.status !== "running" || run.backup_id !== job.backupId) {
    return { kind: "stop", reason: "stale" };
  }
  const settings = await readBackupSettings(db);
  const material = keyMaterialOf(settings);
  if (!material) {
    await failBackup(deps, job, "No backup passphrase is set.");
    return { kind: "stop", reason: "no passphrase" };
  }
  const encryptionKey = deps.secrets.encryptionKey;
  if (!encryptionKey) {
    await failBackup(deps, job, "ENCRYPTION_KEY is missing.");
    return { kind: "stop", reason: "no encryption key" };
  }

  // One query for every mark: one row with a column per table. MAX(rowid) reads one row
  // per table from the rowid b-tree. (D1 limits the terms of a UNION, not the columns.)
  const columns = BACKUP_TABLES.map((table) => `(SELECT MAX(rowid) FROM "${table}") AS "${table}"`);
  const marks = await db.d1
    .prepare(`SELECT ${columns.join(", ")}`)
    .all<Record<string, number | null>>();
  const markRow = marks.results[0] ?? {};
  await addReads(db, job.runId, marks.meta.rows_read ?? 0, utcDay(now));

  const dataKey = generateDataKey();
  const secrets: DeploymentSecrets = {
    signingKey: deps.secrets.signingKey ?? null,
    signingKeysRetired: deps.secrets.signingKeysRetired ?? null,
    encryptionKey,
    suppressionKeyId: await suppressionKeyId(db),
  };
  return {
    kind: "ready",
    createdAt: run.started_at,
    keyMaterial: material,
    wrappedKey: await wrapForRecipient(material.publicKey, job.backupId, { dataKey, secrets }),
    sealedKey: await sealDataKey(encryptionKey, job.backupId, dataKey),
    tables: BACKUP_TABLES.map((name) => ({ name, mark: markRow[name] ?? null })),
    s3: Boolean(settings?.s3_config),
  };
}

async function s3Of(deps: BackupDeps): Promise<BackupStore | null> {
  const destination = await decryptS3Destination(
    deps.credentials,
    await readBackupSettings(deps.db),
  );
  return destination ? s3Store(destination, deps.outboundFetch) : null;
}

/** Step 2: one chunk of one table. */
export async function backupChunk(
  deps: BackupDeps,
  job: BackupJob,
  start: ReadyStart,
  cursor: ChunkCursor,
): Promise<ChunkOutcome> {
  const { db } = deps;
  const clock = Math.max(deps.now, cursor.notBefore);
  const day = utcDay(clock);
  const budget = deps.readBudget ?? BACKUP_READ_BUDGET;
  if ((await rowsReadOnDay(db, day)) + CHUNK_READ_ESTIMATE > budget) {
    return { kind: "budget", resumeAt: nextUtcMidnight(clock) + RESET_MARGIN_MS };
  }
  const table = start.tables[cursor.table];
  if (!table || table.mark === null) {
    return {
      kind: "chunk",
      chunk: null,
      next: { table: cursor.table + 1, afterRowid: 0 },
      s3Error: null,
    };
  }

  const limit = CHUNK_ROWS_BY_TABLE[table.name] ?? CHUNK_ROWS;
  const result = await db.d1
    .prepare(
      `SELECT rowid AS "__backup_rowid", * FROM "${table.name}" WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid LIMIT ?3`,
    )
    .bind(cursor.afterRowid, table.mark, limit)
    .all<Record<string, unknown>>();
  const rowsRead = result.meta.rows_read ?? result.results.length;
  const rows: Record<string, unknown>[] = [];
  let lastRowid = cursor.afterRowid;
  let firstRowid = 0;
  let size = 0;
  for (const raw of result.results) {
    const { __backup_rowid: rowid, ...row } = raw;
    const lineBytes = encodeRows([row]).length;
    if (rows.length > 0 && size + lineBytes > MAX_CHUNK_BYTES) break;
    if (rows.length === 0) firstRowid = Number(rowid);
    rows.push(row);
    size += lineBytes;
    lastRowid = Number(rowid);
  }
  const tableDone =
    lastRowid >= table.mark ||
    (rows.length === result.results.length && result.results.length < limit);
  const next = tableDone
    ? { table: cursor.table + 1, afterRowid: 0 }
    : { table: cursor.table, afterRowid: lastRowid };

  if (rows.length === 0) {
    await addReads(db, job.runId, rowsRead, day);
    return { kind: "chunk", chunk: null, next, s3Error: null };
  }

  const dataKey = await openDataKey(
    deps.secrets.encryptionKey ?? "",
    job.backupId,
    start.sealedKey,
  );
  const sealed = await encryptChunk(dataKey, job.backupId, cursor.index, encodeRows(rows));
  const key = chunkKey(cursor.index);
  const objectKey = backupPrefix(job.backupId) + key;
  await r2Store(deps.bucket).put(objectKey, sealed, "application/octet-stream");

  let s3Error: string | null = null;
  if (!cursor.skipS3) {
    try {
      const s3 = await s3Of(deps);
      if (!s3) throw new S3Error("The S3 destination was removed during the backup.");
      await s3.put(objectKey, sealed, "application/octet-stream");
    } catch (error) {
      s3Error = message(error);
    }
  }

  const chunk: ManifestChunk = {
    index: cursor.index,
    table: table.name,
    key,
    rows: rows.length,
    firstRowid,
    lastRowid,
    bytes: sealed.length,
    sha256: await sha256Base64Url(sealed),
  };
  await db.db
    .updateTable("backup_runs")
    .set({
      ...readMeter(rowsRead, day),
      chunk_count: sql<number>`chunk_count + 1`,
      row_count: sql<number>`row_count + ${rows.length}`,
      size_bytes: sql<number>`size_bytes + ${sealed.length}`,
      ...(s3Error ? { s3_error: s3Error } : {}),
    })
    .where("id", "=", job.runId)
    .execute();
  return { kind: "chunk", chunk, next, s3Error };
}

/** Step 3: the signed manifest and the final status. */
export async function finishBackup(
  deps: BackupDeps,
  job: BackupJob,
  start: ReadyStart,
  chunks: readonly ManifestChunk[],
  s3Failure: string | null,
): Promise<FinishOutcome> {
  const rowsByTable = new Map<TableName, number>();
  for (const chunk of chunks) {
    rowsByTable.set(chunk.table, (rowsByTable.get(chunk.table) ?? 0) + chunk.rows);
  }
  const tables: ManifestTable[] = start.tables.map((table) => ({
    name: table.name,
    scope: TABLE_SCOPE[table.name],
    highWaterMark: table.mark,
    rows: rowsByTable.get(table.name) ?? 0,
  }));
  const body: ManifestBody = {
    format: BACKUP_FORMAT_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    backupId: job.backupId,
    createdAt: start.createdAt,
    tables,
    chunks: [...chunks],
    totalRows: chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
    wrappedKey: start.wrappedKey,
    keyMaterial: start.keyMaterial,
  };
  const dataKey = await openDataKey(
    deps.secrets.encryptionKey ?? "",
    job.backupId,
    start.sealedKey,
  );
  const manifest = await signManifest(body, dataKey);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const key = backupPrefix(job.backupId) + MANIFEST_KEY;
  await r2Store(deps.bucket).put(key, bytes, "application/json");

  let s3Error = s3Failure;
  const destinations = ["r2"];
  if (start.s3 && !s3Error) {
    try {
      const s3 = await s3Of(deps);
      if (!s3) throw new S3Error("The S3 destination was removed during the backup.");
      await s3.put(key, bytes, "application/json");
      destinations.push("s3");
    } catch (error) {
      s3Error = message(error);
    }
  }
  const status = s3Error ? "partial" : "succeeded";
  await deps.db.db
    .updateTable("backup_runs")
    .set({
      status,
      finished_at: deps.now,
      destinations: JSON.stringify(destinations),
      s3_error: s3Error,
      size_bytes: sql<number>`size_bytes + ${bytes.length}`,
    })
    .where("id", "=", job.runId)
    .execute();
  return { status };
}

// The driver ----------------------------------------------------------------------------

/** How a run executes steps: as Workflow steps, or directly in tests. */
export interface BackupRunner {
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, until: number): Promise<void>;
}

export interface BackupSteps {
  begin(): Promise<BackupStart>;
  chunk(start: ReadyStart, cursor: ChunkCursor): Promise<ChunkOutcome>;
  finish(
    start: ReadyStart,
    chunks: ManifestChunk[],
    s3Error: string | null,
  ): Promise<FinishOutcome>;
  fail(error: string): Promise<void>;
}

/**
 * Runs one backup. Step names depend only on earlier step results, so a Workflow replay
 * takes the same path. Returns the end state.
 */
export async function driveBackup(runner: BackupRunner, steps: BackupSteps): Promise<string> {
  const start = await runner.step("begin", () => steps.begin());
  if (start.kind === "stop") return start.reason;

  const chunks: ManifestChunk[] = [];
  let s3Error: string | null = null;
  let cursor: ChunkCursor = { table: 0, afterRowid: 0, index: 0, notBefore: 0, skipS3: !start.s3 };
  let pauses = 0;
  for (let used = 1; ; ) {
    while (cursor.table < start.tables.length && start.tables[cursor.table]?.mark === null) {
      cursor = { ...cursor, table: cursor.table + 1, afterRowid: 0 };
    }
    if (cursor.table >= start.tables.length) break;
    if (used >= MAX_BACKUP_STEPS) {
      await runner.step("too large", () =>
        steps.fail("The database has too many rows for one backup."),
      );
      return "too large";
    }
    const at = cursor;
    const suffix = pauses > 0 ? ` (after pause ${pauses})` : "";
    const outcome = await runner.step(`table ${at.table} after ${at.afterRowid}${suffix}`, () =>
      steps.chunk(start, at),
    );
    used += 1;
    if (outcome.kind === "budget") {
      pauses += 1;
      await runner.sleepUntil(`wait for the read budget ${pauses}`, outcome.resumeAt);
      used += 1;
      cursor = { ...cursor, notBefore: outcome.resumeAt };
      continue;
    }
    if (outcome.s3Error && !s3Error) s3Error = outcome.s3Error;
    cursor = {
      ...cursor,
      table: outcome.next.table,
      afterRowid: outcome.next.afterRowid,
      index: outcome.chunk ? cursor.index + 1 : cursor.index,
      skipS3: cursor.skipS3 || s3Error !== null,
    };
    if (outcome.chunk) chunks.push(outcome.chunk);
  }
  const done = await runner.step("finish", () => steps.finish(start, chunks, s3Error));
  return done.status;
}

/** The steps of one run on fresh deps per step. */
export function backupSteps(
  deps: (work: (deps: BackupDeps) => Promise<unknown>) => Promise<unknown>,
  job: BackupJob,
): BackupSteps {
  const use = <T>(work: (d: BackupDeps) => Promise<T>) => deps(work) as Promise<T>;
  return {
    begin: () => use((d) => beginBackup(d, job)),
    chunk: (start, cursor) => use((d) => backupChunk(d, job, start, cursor)),
    finish: (start, chunks, s3Error) => use((d) => finishBackup(d, job, start, chunks, s3Error)),
    fail: (error) => use((d) => failBackup(d, job, error)),
  };
}

// Start and retention -----------------------------------------------------------------

export type BackupJobStarter = (job: BackupJob) => Promise<void>;

/**
 * Creates a run row and starts the backup Workflow. Throws a conflict while another run
 * is running, and invalid_input when no passphrase is set.
 */
export async function startBackup(
  db: DbConnection,
  startJob: BackupJobStarter,
  trigger: "schedule" | "manual",
  now: number,
): Promise<BackupRunRow> {
  if (!keyMaterialOf(await readBackupSettings(db))) {
    throw new OperationError("invalid_input", "Set a backup passphrase first.");
  }
  if (await activeRun(db, now)) {
    throw new OperationError("conflict", "A backup is already running.");
  }
  const run = await db.db
    .insertInto("backup_runs")
    .values({ backup_id: crypto.randomUUID(), trigger, started_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  try {
    await startJob({ runId: run.id, backupId: run.backup_id });
  } catch (error) {
    await db.db
      .updateTable("backup_runs")
      .set({ status: "failed", finished_at: now, error: "The backup could not start." })
      .where("id", "=", run.id)
      .execute();
    throw error;
  }
  return run;
}

/** Retention deletes at most this many backups per cron run. */
const RETENTION_BATCH = 20;

export interface RetentionDeps {
  db: DbConnection;
  bucket: R2Bucket;
  credentials?: CredentialCipher | undefined;
  outboundFetch: typeof fetch;
}

/**
 * Deletes backups older than the retention period from R2 and S3 (R2). The newest
 * backup that R2 holds (succeeded or partial) always stays, however old it is.
 * Returns the backup ids that it deleted.
 */
export async function applyRetention(deps: RetentionDeps, now: number): Promise<string[]> {
  const { db } = deps;
  const settings = await readBackupSettings(db);
  const days = settings?.retention_days ?? 14;
  const newest = await db.db
    .selectFrom("backup_runs")
    .select("id")
    .where("status", "in", ["succeeded", "partial"])
    .where("deleted_at", "is", null)
    .orderBy("started_at", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  let query = db.db
    .selectFrom("backup_runs")
    .selectAll()
    .where("deleted_at", "is", null)
    .where("status", "<>", "running")
    .where("started_at", "<", now - days * 24 * 60 * 60 * 1000);
  if (newest) query = query.where("id", "<>", newest.id);
  const expired = await query.orderBy("started_at").limit(RETENTION_BATCH).execute();
  if (expired.length === 0) return [];

  let s3: BackupStore | null = null;
  try {
    const destination = await decryptS3Destination(deps.credentials, settings);
    s3 = destination ? s3Store(destination, deps.outboundFetch) : null;
  } catch (error) {
    console.error("Backup retention cannot read the S3 settings", error);
  }
  const deleted: string[] = [];
  for (const run of expired) {
    const prefix = backupPrefix(run.backup_id);
    try {
      const keys = await listR2Keys(deps.bucket, prefix);
      // A run whose S3 copy failed part way can have some chunks there too.
      if (s3 && (parseDestinations(run.destinations).includes("s3") || run.s3_error)) {
        const s3Keys = [
          prefix + MANIFEST_KEY,
          ...Array.from({ length: run.chunk_count }, (_, i) => prefix + chunkKey(i)),
        ];
        await s3.delete(s3Keys);
      }
      await r2Store(deps.bucket).delete(keys);
      await db.db
        .updateTable("backup_runs")
        .set({ deleted_at: now })
        .where("id", "=", run.id)
        .execute();
      deleted.push(run.backup_id);
    } catch (error) {
      console.error(`Backup retention failed for ${run.backup_id}`, error);
    }
  }
  return deleted;
}
