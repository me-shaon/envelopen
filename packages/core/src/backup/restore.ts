import { chunkedInsert, type DbConnection, nextUtcMidnight, type TableName } from "@envelopen/db";
import { type Kysely, sql } from "kysely";
import {
  type CredentialCipher,
  type CredentialOwner,
  createCredentialCipher,
} from "../crypto/credentials";
import { OperationError } from "../errors";
import { repairAllCounts } from "../lists/counts";
import type { RestoreJob, SettingsCache, UsageReader } from "../services";
import { signingKeyRing } from "../suppression/hash";
import {
  type BackupSource,
  chunkOffsets,
  parseManifest,
  r2ArchiveChunkReader,
  r2ArchiveSource,
  r2FolderSource,
} from "./archive";
import {
  BackupCryptoError,
  type DeploymentSecrets,
  decryptChunk,
  fromBase64Url,
  openDataKey,
  sealDataKey,
  segmentCount,
  toBase64Url,
  unwrapWithPrivateKey,
} from "./crypto";
import {
  beginKeyDerivation,
  clearDerivationResult,
  deriveSegment,
  failKeyDerivation,
  finishKeyDerivation,
  openDerivedPrivateKey,
  type SegmentOutcome,
} from "./derivation";
import {
  type BackupRow,
  decodeRows,
  decodeValue,
  type Manifest,
  type ManifestChunk,
  sha256Base64Url,
  verifyManifest,
} from "./format";
import { RESTORE_ACK_SETTING } from "./restore-ack";
import {
  DEFERRED_REFERENCES,
  FOREIGN_KEYS,
  RESTORE_ORDER,
  schemaProblem,
  TRIGGER_COUNTS,
  upgradeRow,
} from "./restore-plan";
import { RESET_MARGIN_MS } from "./run";
import {
  decryptImportedKeys,
  encryptImportedKeys,
  IMPORTED_SIGNING_KEYS_SETTING,
  keysToImport,
  readImportedKeysValue,
} from "./signing-keys";

// The restore engine (U5, KTD3). It writes a backup into a fresh deployment: one where
// the first-run screen has not created an owner yet. The restore Workflow
// (apps/worker/src/workflows/restore-workflow.ts) runs each function below as one step,
// through `driveRestore`. Tests run the same driver without a Workflow.
//
// 1. derive: the passphrase key derivation of the backup's key material, one PBKDF2
//    segment per step (derivation.ts). A wrong passphrase fails the last step, before
//    the restore writes any row.
// 2. open: unwraps the data key and the backup's deployment secrets, checks the
//    manifest tag and the schema version, and seals the key for the next steps. It
//    sets the restore_ack_required flag, so no campaign sends until the owner agrees.
// 3. chunk: one backup chunk per step, in foreign-key order (restore-plan.ts). It checks
//    the chunk hash, decrypts it, re-encrypts the encrypted columns under this
//    deployment's ENCRYPTION_KEY, leaves out orphan rows, and inserts the rows with
//    `chunkedInsert`. The rows and the progress commit in one D1 batch, so a resumed
//    run starts at the next chunk. Before each chunk, it checks the D1 daily write
//    budget, and waits for the reset when the chunk does not fit.
// 4. finish: sets the deferred references, recounts the member counts, imports the
//    backup's signing keys, and writes the owner marker last.

/** A restore leaves this many D1 rows written per day for the other paths. */
export const RESTORE_WRITE_RESERVE = 10_000;
/** D1 rows written per row inserted before the run measured its own ratio (indexes count). */
export const DEFAULT_WRITE_FACTOR = 3;
/** Workflows allow 1,024 steps per instance. A longer restore goes on in a new instance. */
export const RESTORE_MAX_STEPS = 900;
/** A run in deriving, running, or waiting with no change for this long counts as stopped. */
export const STALE_RESTORE_MS = 3 * 24 * 60 * 60 * 1000;
/** `system_settings` key of the owner. The first-run screen closes when it exists. */
export const OWNER_SETTING = "owner_user_id";

export type RestoreErrorCode = "wrong_passphrase" | "invalid_backup" | "failed";

/** One backup chunk in the order of the restore. */
export interface RestorePlanEntry {
  index: number;
  table: TableName;
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface RestoreDeps {
  db: DbConnection;
  bucket: R2Bucket;
  /** This deployment's credentials cipher (ENCRYPTION_KEY). */
  cipher: CredentialCipher;
  /** This deployment's ENCRYPTION_KEY, to seal the key between steps. */
  encryptionKey: string;
  /** This deployment's signing keys, to find the keys the backup adds. */
  signingKey?: string | undefined;
  signingKeysRetired?: string | undefined;
  /** The daily D1 writes. Without it, the run checks only the D1 limit errors. */
  usage?: UsageReader | undefined;
  /** D1 rows that the restore may let the day reach. Defaults to the limit minus the reserve. */
  writeBudget?: number | undefined;
  settingsCache?: SettingsCache | undefined;
  /** Counts a wrong passphrase, so the first-run screen locks after repeated ones. */
  onWrongPassphrase?: (() => Promise<void>) | undefined;
  now: number;
}

// Reading the run ------------------------------------------------------------------------

export async function readRestoreRun(db: DbConnection, runId: number) {
  return db.db.selectFrom("restore_runs").selectAll().where("id", "=", runId).executeTakeFirst();
}

/** The newest restore of this deployment, or undefined. */
export async function latestRestoreRun(db: DbConnection) {
  return db.db
    .selectFrom("restore_runs")
    .selectAll()
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
}

function isActive(run: { status: string; updated_at: number }, now: number): boolean {
  return (
    (run.status === "deriving" || run.status === "running" || run.status === "waiting") &&
    run.updated_at > now - STALE_RESTORE_MS
  );
}

/** True while a restore runs. The first-run owner form and the cron wait for it. */
export async function restoreInProgress(db: DbConnection, now: number): Promise<boolean> {
  const run = await latestRestoreRun(db);
  return run !== undefined && isActive(run, now);
}

/** True when the deployment holds users, sign-in accounts, or workspaces. */
async function holdsData(db: DbConnection): Promise<boolean> {
  const row = await db.d1
    .prepare(
      "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM auth_user) + (SELECT COUNT(*) FROM workspaces) AS n",
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

async function ownerId(db: DbConnection): Promise<string | null> {
  const row = await db.db
    .selectFrom("system_settings")
    .select("value")
    .where("key", "=", OWNER_SETTING)
    .executeTakeFirst();
  return row?.value ?? null;
}

// Start --------------------------------------------------------------------------------------

export interface RestoreStartInput {
  source: "r2" | "upload";
  /** The backup id (r2) or the R2 key of the uploaded archive (upload). */
  sourceKey: string;
  manifest: Manifest;
  passphrase: string;
  ip?: string | null;
}

export interface RestoreStart {
  job: RestoreJob;
  runId: number;
}

/**
 * Checks that this deployment can take the backup, stores the run and its table
 * progress, and begins the passphrase derivation. It writes no data row.
 *
 * - An owner exists: refused (KTD3: restore only into a fresh deployment).
 * - Another restore runs: refused.
 * - Rows exist from an earlier, failed restore of the same backup: the run goes on from
 *   its last committed chunk. Rows of anything else: refused.
 */
export async function beginRestore(
  db: DbConnection,
  cipher: CredentialCipher,
  input: RestoreStartInput,
  now: number,
): Promise<RestoreStart> {
  const problem = schemaProblem(input.manifest.schemaVersion);
  if (problem) throw new OperationError("invalid_input", problem);
  if ((await ownerId(db)) !== null) {
    throw new OperationError(
      "conflict",
      "This deployment has an owner. Restore only works before setup.",
    );
  }
  const latest = await latestRestoreRun(db);
  if (latest && isActive(latest, now)) {
    throw new OperationError("conflict", "A restore is already running.");
  }
  const resume =
    latest?.status === "failed" &&
    latest.backup_id === input.manifest.backupId &&
    latest.position > 0
      ? latest
      : undefined;
  if (!resume && (await holdsData(db))) {
    throw new OperationError(
      "conflict",
      "This deployment already holds data. Restore into a new, empty deployment.",
    );
  }

  const derivation = await beginKeyDerivation(
    db,
    cipher,
    { purpose: "unwrap", passphrase: input.passphrase, material: input.manifest.keyMaterial },
    now,
  );
  if (resume) {
    const generation = resume.generation + 1;
    await db.db
      .updateTable("restore_runs")
      .set({
        status: "deriving",
        source: input.source,
        source_key: input.sourceKey,
        derivation_id: derivation.derivationId,
        sealed_key: null,
        key_version: null,
        generation,
        resume_at: null,
        failed_step: null,
        error: null,
        error_code: null,
        ip: input.ip ?? null,
        updated_at: now,
        finished_at: null,
      })
      .where("id", "=", resume.id)
      .execute();
    return { runId: resume.id, job: { runId: resume.id, generation } };
  }

  const manifest = input.manifest;
  const run = await db.db
    .insertInto("restore_runs")
    .values({
      source: input.source,
      source_key: input.sourceKey,
      backup_id: manifest.backupId,
      backup_created_at: manifest.createdAt,
      schema_version: manifest.schemaVersion,
      total_rows: manifest.totalRows,
      chunk_count: manifest.chunks.length,
      derivation_id: derivation.derivationId,
      ip: input.ip ?? null,
      started_at: now,
      updated_at: now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const rowsByTable = new Map<string, number>();
  for (const table of manifest.tables) rowsByTable.set(table.name, table.rows);
  const tables = RESTORE_ORDER.filter((name) => rowsByTable.has(name)).map((name, ord) => ({
    run_id: run.id,
    table_name: name,
    ord,
    total_rows: rowsByTable.get(name) ?? 0,
  }));
  for (const query of chunkedInsert(db.db, "restore_tables", tables)) await query.execute();
  return { runId: run.id, job: { runId: run.id, generation: 0 } };
}

/**
 * Marks the run failed and clears the sealed key. The rows that committed stay: a new
 * start with the passphrase goes on from the last committed chunk.
 */
export async function failRestore(
  db: DbConnection,
  job: RestoreJob,
  step: string,
  message: string,
  code: RestoreErrorCode,
  now: number,
): Promise<void> {
  const run = await readRestoreRun(db, job.runId);
  if (!run || run.generation !== job.generation) return;
  if (run.derivation_id !== null) {
    await failKeyDerivation(
      db,
      { derivationId: run.derivation_id, segments: 0 },
      "The restore stopped.",
      now,
    );
    await clearDerivationResult(db, run.derivation_id);
  }
  await db.db
    .updateTable("restore_runs")
    .set({
      status: "failed",
      failed_step: step.slice(0, 120),
      error: message.slice(0, 500),
      error_code: code,
      resume_at: null,
      updated_at: now,
      finished_at: now,
      sealed_key: null,
      key_version: null,
    })
    .where("id", "=", job.runId)
    .where("generation", "=", job.generation)
    .execute();
}

// Steps ---------------------------------------------------------------------------------------

export type PrepareOutcome =
  | { kind: "stop"; reason: string }
  | { kind: "derive"; segments: number }
  | { kind: "open" };

/** Step: what this instance has to do first. */
export async function prepareRestore(
  deps: Pick<RestoreDeps, "db">,
  job: RestoreJob,
): Promise<PrepareOutcome> {
  const run = await readRestoreRun(deps.db, job.runId);
  if (!run || run.generation !== job.generation) return { kind: "stop", reason: "stale" };
  if (run.status === "succeeded" || run.status === "failed") {
    return { kind: "stop", reason: run.status };
  }
  if (run.sealed_key) return { kind: "open" };
  if (run.derivation_id === null) return { kind: "stop", reason: "no derivation" };
  const derivation = await deps.db.db
    .selectFrom("key_derivations")
    .select(["status", "kdf_iterations"])
    .where("id", "=", run.derivation_id)
    .executeTakeFirst();
  if (!derivation) return { kind: "stop", reason: "no derivation" };
  return { kind: "derive", segments: segmentCount(derivation.kdf_iterations) };
}

async function derivationJob(db: DbConnection, job: RestoreJob) {
  const run = await readRestoreRun(db, job.runId);
  if (!run?.derivation_id) throw new BackupCryptoError("The restore has no key derivation.");
  const row = await db.db
    .selectFrom("key_derivations")
    .select("kdf_iterations")
    .where("id", "=", run.derivation_id)
    .executeTakeFirstOrThrow();
  return { derivationId: run.derivation_id, segments: segmentCount(row.kdf_iterations) };
}

/** Step: one PBKDF2 segment of the passphrase derivation. */
export async function restoreSegment(
  deps: Pick<RestoreDeps, "db" | "cipher">,
  job: RestoreJob,
  index: number,
): Promise<SegmentOutcome> {
  return deriveSegment(deps.db, deps.cipher, await derivationJob(deps.db, job), index);
}

export type PassphraseOutcome = { status: "ready" } | { status: "wrong" | "stopped" };

/**
 * Step: the end of the derivation, which checks the passphrase. A wrong passphrase fails
 * the run here, before any data row.
 */
export async function checkRestorePassphrase(
  deps: Pick<RestoreDeps, "db" | "cipher" | "now" | "onWrongPassphrase">,
  job: RestoreJob,
): Promise<PassphraseOutcome> {
  const outcome = await finishKeyDerivation(
    deps.db,
    deps.cipher,
    await derivationJob(deps.db, job),
    deps.now,
  );
  if (outcome.status === "ready") return { status: "ready" };
  if (outcome.status === "failed") {
    await failRestore(
      deps.db,
      job,
      "check the passphrase",
      "The passphrase is not correct.",
      "wrong_passphrase",
      deps.now,
    );
    try {
      await deps.onWrongPassphrase?.();
    } catch (error) {
      console.error("The wrong passphrase was not counted", error);
    }
    return { status: "wrong" };
  }
  return { status: "stopped" };
}

/** What the steps after `open` carry: the sealed key and the plan. Both are safe to store. */
export interface OpenedRestore {
  kind: "opened";
  /** {dataKey, secrets}, sealed with this deployment's ENCRYPTION_KEY. */
  sealedKey: string;
  backupId: string;
  schemaVersion: number;
  plan: RestorePlanEntry[];
  /** Byte offsets of the chunks in an uploaded archive. Empty for an R2 folder. */
  offsets: [number, number][];
}

export type OpenOutcome = OpenedRestore | { kind: "invalid"; message: string };

interface OpenedKey {
  dataKey: Uint8Array;
  secrets: DeploymentSecrets;
}

function sealLabel(runId: number): string {
  return `restore:${runId}`;
}

async function sealKey(deps: RestoreDeps, runId: number, key: OpenedKey): Promise<string> {
  const body = new TextEncoder().encode(
    JSON.stringify({ dataKey: toBase64Url(key.dataKey), secrets: key.secrets }),
  );
  return sealDataKey(deps.encryptionKey, sealLabel(runId), body);
}

async function openKey(deps: RestoreDeps, runId: number, sealed: string): Promise<OpenedKey> {
  const body = await openDataKey(deps.encryptionKey, sealLabel(runId), sealed);
  const parsed = JSON.parse(new TextDecoder().decode(body)) as {
    dataKey: string;
    secrets: DeploymentSecrets;
  };
  return { dataKey: fromBase64Url(parsed.dataKey), secrets: parsed.secrets };
}

/** The source of a run. */
export function restoreSource(
  bucket: R2Bucket,
  run: { source: string; source_key: string },
): BackupSource {
  return run.source === "r2"
    ? r2FolderSource(bucket, run.source_key)
    : r2ArchiveSource(bucket, run.source_key);
}

/** Checks the manifest against the restore plan rules. Returns a problem, or null. */
function manifestProblem(manifest: Manifest, backupId: string): string | null {
  if (manifest.backupId !== backupId) return "The backup changed since the restore started.";
  const problem = schemaProblem(manifest.schemaVersion);
  if (problem) return problem;
  const seen = new Set<number>();
  for (const chunk of manifest.chunks) {
    if (!RESTORE_ORDER.includes(chunk.table))
      return `The backup has an unknown table ${chunk.table}.`;
    if (seen.has(chunk.index)) return "The backup lists a chunk twice.";
    seen.add(chunk.index);
  }
  return null;
}

/**
 * Step: opens the backup. The first instance unwraps the key with the derived private
 * key, then clears the derivation result. A later instance opens the sealed key from
 * the run. Either way it checks the manifest tag before the first data row.
 */
export async function openRestore(deps: RestoreDeps, job: RestoreJob): Promise<OpenOutcome> {
  const { db, now } = deps;
  const run = await readRestoreRun(db, job.runId);
  if (!run || run.generation !== job.generation) throw new Error("The restore run changed.");
  const source = restoreSource(deps.bucket, run);
  const manifestBytes = await source.manifestBytes();
  const fail = async (message: string): Promise<OpenOutcome> => {
    await failRestore(db, job, "open the backup", message, "invalid_backup", now);
    return { kind: "invalid", message };
  };
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (error) {
    return fail((error as Error).message);
  }

  let key: OpenedKey;
  if (run.sealed_key) {
    key = await openKey(deps, run.id, run.sealed_key);
  } else {
    if (run.derivation_id === null) return fail("The restore has no key derivation.");
    try {
      const { privateKey, material } = await openDerivedPrivateKey(
        db,
        deps.cipher,
        run.derivation_id,
      );
      key = await unwrapWithPrivateKey(
        manifest.wrappedKey,
        manifest.backupId,
        privateKey,
        fromBase64Url(material.publicKey),
      );
    } catch {
      await clearDerivationResult(db, run.derivation_id);
      return fail("The backup key does not open with this passphrase. The backup may be changed.");
    }
    await clearDerivationResult(db, run.derivation_id);
  }
  try {
    await verifyManifest(manifest, key.dataKey);
  } catch (error) {
    return fail((error as Error).message);
  }
  const problem = manifestProblem(manifest, run.backup_id);
  if (problem) return fail(problem);

  const sealedKey = run.sealed_key ?? (await sealKey(deps, run.id, key));
  const flag = JSON.stringify({
    backupId: manifest.backupId,
    backupCreatedAt: manifest.createdAt,
    restoredAt: now,
  });
  await db.atomic([
    db.db
      .updateTable("restore_runs")
      .set({ status: "running", sealed_key: sealedKey, updated_at: now })
      .where("id", "=", run.id),
    // No campaign sends until the owner agrees to the age of the backup (KTD3).
    db.db
      .insertInto("system_settings")
      .values({ key: RESTORE_ACK_SETTING, value: flag })
      .onConflict((oc) => oc.column("key").doNothing()),
  ]);

  const order = new Map(RESTORE_ORDER.map((table, index) => [table, index]));
  const plan = [...manifest.chunks]
    .sort((a, b) => (order.get(a.table) ?? 0) - (order.get(b.table) ?? 0) || a.index - b.index)
    .map((chunk) => ({
      index: chunk.index,
      table: chunk.table,
      key: chunk.key,
      rows: chunk.rows,
      bytes: chunk.bytes,
      sha256: chunk.sha256,
    }));
  const offsets =
    run.source === "upload" ? [...chunkOffsets(manifest, manifestBytes.length).entries()] : [];
  return {
    kind: "opened",
    sealedKey,
    backupId: manifest.backupId,
    schemaVersion: manifest.schemaVersion,
    plan,
    offsets,
  };
}

// One chunk -------------------------------------------------------------------------------------

export type RestoreChunkOutcome =
  | { kind: "done"; inserted: number; skipped: number }
  | { kind: "wait"; resumeAt: number };

type AnyDb = Record<string, Record<string, unknown>>;
type RowValue = string | number | null | Uint8Array;
type Row = Record<string, RowValue>;

/** Ciphers of the backup's ENCRYPTION_KEY, one per key version. */
function backupCiphers(secrets: DeploymentSecrets) {
  const ciphers = new Map<number, Promise<CredentialCipher>>();
  return (version: number): Promise<CredentialCipher> => {
    if (!secrets.encryptionKey) {
      throw new BackupCryptoError(
        "The backup has encrypted values but no ENCRYPTION_KEY, so they cannot be restored.",
      );
    }
    let cipher = ciphers.get(version);
    if (!cipher) {
      cipher = createCredentialCipher([{ version, secret: secrets.encryptionKey }]);
      ciphers.set(version, cipher);
    }
    return cipher;
  };
}

async function reencrypt(
  from: (version: number) => Promise<CredentialCipher>,
  to: CredentialCipher,
  value: RowValue,
  version: number,
  owner: CredentialOwner,
): Promise<string | null> {
  if (value === null) return null;
  if (typeof value !== "string") throw new BackupCryptoError("An encrypted value is not text.");
  const plain = await (await from(version)).decrypt(value, version, owner);
  return to.encrypt(plain, owner);
}

/** Re-encrypts the columns that ENCRYPTION_KEY protects, from the backup's key to ours. */
async function transformEncrypted(
  table: TableName,
  row: Row,
  from: (version: number) => Promise<CredentialCipher>,
  to: CredentialCipher,
): Promise<Row> {
  if (table === "provider_connections") {
    const version = Number(row.credentials_key_version);
    const owner = (purpose: "credentials" | "webhook_secret"): CredentialOwner => ({
      workspaceId: Number(row.workspace_id),
      purpose,
      connectionId: Number(row.id),
    });
    return {
      ...row,
      credentials_encrypted: await reencrypt(
        from,
        to,
        row.credentials_encrypted ?? null,
        version,
        owner("credentials"),
      ),
      webhook_secret_encrypted: await reencrypt(
        from,
        to,
        row.webhook_secret_encrypted ?? null,
        version,
        owner("webhook_secret"),
      ),
      credentials_key_version: to.version,
    };
  }
  if (table === "backup_settings" && row.s3_config !== null && row.s3_config !== undefined) {
    return {
      ...row,
      s3_config: await reencrypt(from, to, row.s3_config, Number(row.s3_key_version), {
        workspaceId: 0,
        purpose: "backup_destination",
        connectionId: 1,
      }),
      s3_key_version: to.version,
    };
  }
  if (table === "system_settings" && row.key === IMPORTED_SIGNING_KEYS_SETTING) {
    const value = String(row.value);
    const parsed = JSON.parse(value) as { v: number };
    const keys = await decryptImportedKeys(await from(parsed.v), value);
    return { ...row, value: await encryptImportedKeys(to, keys) };
  }
  return row;
}

/** Ids that exist in the parent tables, by "parent:id". One D1 batch for every lookup. */
async function existingParents(
  db: DbConnection,
  wanted: Map<TableName, Set<string | number>>,
): Promise<Set<string>> {
  const statements: D1PreparedStatement[] = [];
  const parents: TableName[] = [];
  for (const [parent, ids] of wanted) {
    const list = [...ids];
    for (let start = 0; start < list.length; start += 90) {
      const part = list.slice(start, start + 90);
      statements.push(
        db.d1
          .prepare(`SELECT id FROM "${parent}" WHERE id IN (${part.map(() => "?").join(",")})`)
          .bind(...part),
      );
      parents.push(parent);
    }
  }
  const found = new Set<string>();
  if (statements.length === 0) return found;
  const results = await db.d1.batch<{ id: string | number }>(statements);
  results.forEach((result, position) => {
    for (const row of result.results ?? []) found.add(`${parents[position]}:${String(row.id)}`);
  });
  return found;
}

interface Prepared {
  rows: Row[];
  skipped: number;
  owner: string | null;
}

/** Decodes, upgrades, re-encrypts, and checks the references of the rows of one chunk. */
async function prepareRows(
  deps: RestoreDeps,
  table: TableName,
  raw: BackupRow[],
  schemaVersion: number,
  secrets: DeploymentSecrets,
): Promise<Prepared> {
  const from = backupCiphers(secrets);
  let owner: string | null = null;
  const decoded: Row[] = [];
  for (const backupRow of raw) {
    const upgraded = upgradeRow(table, backupRow, schemaVersion);
    let row: Row = {};
    for (const [column, value] of Object.entries(upgraded)) row[column] = decodeValue(value);
    if (table === "system_settings") {
      // The owner marker goes in last, and this deployment keeps its own restore flag.
      if (row.key === OWNER_SETTING) {
        owner = row.value === null ? null : String(row.value);
        continue;
      }
      if (row.key === RESTORE_ACK_SETTING) continue;
    }
    row = await transformEncrypted(table, row, from, deps.cipher);
    for (const column of TRIGGER_COUNTS[table] ?? []) {
      if (column in row) row[column] = 0;
    }
    for (const deferred of DEFERRED_REFERENCES) {
      if (deferred.table === table && column(row, deferred.column)) row[deferred.column] = null;
    }
    decoded.push(row);
  }

  const keys = (FOREIGN_KEYS[table] ?? []).filter(
    (fk) => !DEFERRED_REFERENCES.some((d) => d.table === table && d.column === fk.column),
  );
  if (keys.length === 0) return { rows: decoded, skipped: 0, owner };
  const wanted = new Map<TableName, Set<string | number>>();
  for (const row of decoded) {
    for (const fk of keys) {
      const value = row[fk.column];
      if (value === null || value === undefined || value instanceof Uint8Array) continue;
      let ids = wanted.get(fk.parent);
      if (!ids) {
        ids = new Set();
        wanted.set(fk.parent, ids);
      }
      ids.add(value);
    }
  }
  const found = await existingParents(deps.db, wanted);
  // A row can point at a row of its own table earlier in the chunk (campaigns.parent_id).
  const earlier = new Set<string>();
  const rows: Row[] = [];
  let skipped = 0;
  for (const row of decoded) {
    let keep = true;
    for (const fk of keys) {
      const value = row[fk.column];
      if (value === null || value === undefined) continue;
      const id = `${fk.parent}:${String(value)}`;
      if (found.has(id) || (fk.parent === table && earlier.has(id))) continue;
      if (fk.onMissing === "clear") {
        row[fk.column] = null;
      } else {
        keep = false;
        break;
      }
    }
    if (!keep) {
      skipped += 1;
      continue;
    }
    if (row.id !== undefined && row.id !== null) earlier.add(`${table}:${String(row.id)}`);
    rows.push(row);
  }
  return { rows, skipped, owner };
}

function column(row: Row, name: string): boolean {
  return Object.hasOwn(row, name);
}

/** D1 rows written per row inserted, from the run so far. */
function writeFactor(run: { rows_written: number; rows_inserted: number }): number {
  if (run.rows_inserted < 100 || run.rows_written <= 0) return DEFAULT_WRITE_FACTOR;
  return Math.max(1, run.rows_written / run.rows_inserted);
}

/** Step: one chunk of the plan, at `position`. */
export async function restoreChunk(
  deps: RestoreDeps,
  job: RestoreJob,
  opened: OpenedRestore,
  position: number,
): Promise<RestoreChunkOutcome> {
  const { db, now } = deps;
  const run = await readRestoreRun(db, job.runId);
  if (!run || run.generation !== job.generation) throw new Error("The restore run changed.");
  // A Workflow retry of a step that committed: the chunk is in.
  if (run.position > position) return { kind: "done", inserted: 0, skipped: 0 };
  if (run.position < position)
    throw new Error(`Chunk ${position} runs before chunk ${run.position}.`);
  const entry = opened.plan[position];
  if (!entry) throw new Error(`The plan has no chunk ${position}.`);

  // The daily write budget (KTD3). A chunk that does not fit waits for the reset.
  if (deps.usage) {
    const status = await deps.usage.status();
    const resumeAt = nextUtcMidnight(now) + RESET_MARGIN_MS;
    const limit = status.platformLimit;
    const budget = deps.writeBudget ?? status.dailyLimit - RESTORE_WRITE_RESERVE;
    const estimate = Math.ceil(entry.rows * writeFactor(run)) + 10;
    const blocked = limit !== null && limit.until > now;
    if (blocked || (status.rowsWritten > 0 && status.rowsWritten + estimate > budget)) {
      const until = blocked ? Math.max(limit.until + RESET_MARGIN_MS, now) : resumeAt;
      await db.db
        .updateTable("restore_runs")
        .set({ status: "waiting", resume_at: until, updated_at: now })
        .where("id", "=", run.id)
        .execute();
      return { kind: "wait", resumeAt: until };
    }
  }

  const sealed = await chunkBytes(deps, run, opened, entry);
  if ((await sha256Base64Url(sealed)) !== entry.sha256) {
    throw new BackupCryptoError(`The backup chunk ${entry.index} does not match its hash.`);
  }
  const key = await openKey(deps, run.id, opened.sealedKey);
  const plain = await decryptChunk(key.dataKey, opened.backupId, entry.index, sealed);
  const prepared = await prepareRows(
    deps,
    entry.table,
    decodeRows(plain),
    opened.schemaVersion,
    key.secrets,
  );

  const anyDb = db.db as unknown as Kysely<AnyDb>;
  const inserts =
    entry.table === "system_settings"
      ? chunkedInsert(anyDb, entry.table, prepared.rows, {
          modify: (query) =>
            query.onConflict((oc) => oc.column("key").doUpdateSet({ value: sql`excluded.value` })),
        })
      : chunkedInsert(anyDb, entry.table, prepared.rows);
  const results = await db.atomic([
    ...inserts,
    db.db
      .updateTable("restore_runs")
      .set({
        status: "running",
        position: position + 1,
        rows_inserted: sql<number>`rows_inserted + ${prepared.rows.length}`,
        rows_skipped: sql<number>`rows_skipped + ${prepared.skipped}`,
        resume_at: null,
        updated_at: now,
        ...(prepared.owner === null ? {} : { owner_user_id: prepared.owner }),
      })
      .where("id", "=", run.id)
      .where("position", "=", position),
    db.db
      .updateTable("restore_tables")
      .set({
        rows_done: sql<number>`rows_done + ${prepared.rows.length}`,
        rows_skipped: sql<number>`rows_skipped + ${prepared.skipped}`,
      })
      .where("run_id", "=", run.id)
      .where("table_name", "=", entry.table),
  ]);
  const written = results.reduce((sum, result) => sum + (result.meta?.rows_written ?? 0), 0);
  try {
    await db.db
      .updateTable("restore_runs")
      .set({ rows_written: sql<number>`rows_written + ${written}` })
      .where("id", "=", run.id)
      .execute();
  } catch (error) {
    // Only the estimate uses it.
    console.error("The restore could not record its writes", error);
  }
  return { kind: "done", inserted: prepared.rows.length, skipped: prepared.skipped };
}

async function chunkBytes(
  deps: RestoreDeps,
  run: { source: string; source_key: string },
  opened: OpenedRestore,
  entry: RestorePlanEntry,
): Promise<Uint8Array> {
  const chunk = { ...entry, firstRowid: 0, lastRowid: 0 } satisfies ManifestChunk;
  if (run.source === "upload") {
    return r2ArchiveChunkReader(deps.bucket, run.source_key, new Map(opened.offsets))(chunk);
  }
  return restoreSource(deps.bucket, run).chunk(chunk);
}

// Finish ----------------------------------------------------------------------------------------

export interface RestoreSummary {
  status: "succeeded";
  rowsInserted: number;
  rowsSkipped: number;
}

/**
 * Step: the references that waited for their parent, the recount, the imported signing
 * keys, the audit row, and the owner marker last.
 */
export async function finishRestore(
  deps: RestoreDeps,
  job: RestoreJob,
  opened: OpenedRestore,
): Promise<RestoreSummary> {
  const { db, now } = deps;
  const run = await readRestoreRun(db, job.runId);
  if (!run || run.generation !== job.generation) throw new Error("The restore run changed.");
  if (run.status === "succeeded") {
    return { status: "succeeded", rowsInserted: run.rows_inserted, rowsSkipped: run.rows_skipped };
  }
  const key = await openKey(deps, run.id, opened.sealedKey);

  // workspaces.sending_connection_id, now that the connections are in.
  for (const entry of opened.plan.filter((item) => item.table === "workspaces")) {
    const sealed = await chunkBytes(deps, run, opened, entry);
    const rows = decodeRows(await decryptChunk(key.dataKey, opened.backupId, entry.index, sealed));
    const updates = rows
      .filter(
        (row) => row.sending_connection_id !== null && row.sending_connection_id !== undefined,
      )
      .map(
        (row) => sql`UPDATE workspaces SET sending_connection_id = ${row.sending_connection_id}
WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM provider_connections c WHERE c.id = ${row.sending_connection_id} AND c.workspace_id = ${row.id})`,
      )
      .map((query) => query.compile(db.db));
    for (let start = 0; start < updates.length; start += 50) {
      await db.atomic(updates.slice(start, start + 50));
    }
  }

  // The triggers counted the members as they went in. The recount checks them.
  await repairAllCounts(db);

  // The backup's signing keys, so old links and the restored suppressions keep working.
  const imported = keysToImport(key.secrets, deps);
  const storedValue = await readImportedKeysValue(db);
  const stored = storedValue ? await decryptImportedKeys(deps.cipher, storedValue) : [];
  const own = deps.signingKey ? signingKeyRing(deps.signingKey, deps.signingKeysRetired) : [];
  const keys = [...new Set([...stored, ...imported])].filter((item) => !own.includes(item));
  const keysValue = keys.length > 0 ? await encryptImportedKeys(deps.cipher, keys) : null;

  const summary = {
    status: "succeeded" as const,
    rowsInserted: run.rows_inserted,
    rowsSkipped: run.rows_skipped,
  };
  await db.atomic([
    ...(keysValue
      ? [
          db.db
            .insertInto("system_settings")
            .values({ key: IMPORTED_SIGNING_KEYS_SETTING, value: keysValue })
            .onConflict((oc) => oc.column("key").doUpdateSet({ value: keysValue })),
        ]
      : []),
    db.db.insertInto("audit_log").values({
      workspace_id: null,
      actor_type: "system",
      actor_id: "setup_token",
      surface: "ui",
      api_key_id: null,
      action: "setup.restored",
      target_type: "backup",
      target_id: opened.backupId,
      metadata: JSON.stringify({
        backupCreatedAt: run.backup_created_at,
        rowsInserted: run.rows_inserted,
        rowsSkipped: run.rows_skipped,
        importedSigningKeys: imported.length,
      }),
      ip: run.ip,
    }),
    ...(run.owner_user_id
      ? [
          db.db
            .insertInto("system_settings")
            .values({ key: OWNER_SETTING, value: run.owner_user_id })
            .onConflict((oc) => oc.column("key").doNothing()),
        ]
      : []),
    db.db
      .updateTable("restore_runs")
      .set({
        status: "succeeded",
        sealed_key: null,
        key_version: null,
        resume_at: null,
        updated_at: now,
        finished_at: now,
      })
      .where("id", "=", run.id),
  ]);
  try {
    if (keysValue) await deps.settingsCache?.put(IMPORTED_SIGNING_KEYS_SETTING, keysValue);
  } catch (error) {
    console.error("The settings cache write failed", error);
  }
  if (run.source === "upload") {
    await deps.bucket.delete(run.source_key).catch((error: unknown) => {
      console.error("The uploaded backup file could not be deleted", error);
    });
  }
  return summary;
}

// The driver ------------------------------------------------------------------------------------

export interface RestoreRunner {
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, until: number): Promise<void>;
}

export interface RestoreSteps {
  prepare(): Promise<PrepareOutcome>;
  segment(index: number): Promise<SegmentOutcome>;
  checkPassphrase(): Promise<PassphraseOutcome>;
  open(): Promise<OpenOutcome>;
  chunk(opened: OpenedRestore, position: number): Promise<RestoreChunkOutcome>;
  finish(opened: OpenedRestore): Promise<RestoreSummary>;
  /** The committed position of the run: where this instance starts. */
  position(): Promise<number>;
  /** Starts the next instance of a long restore. */
  continueRun(): Promise<void>;
  fail(step: string, message: string): Promise<void>;
}

/**
 * Runs one instance of a restore. Step names depend only on earlier step results, so a
 * Workflow replay takes the same path. Returns the end state.
 */
export async function driveRestore(
  runner: RestoreRunner,
  steps: RestoreSteps,
  options: { maxSteps?: number } = {},
): Promise<string> {
  const maxSteps = options.maxSteps ?? RESTORE_MAX_STEPS;
  let current = "prepare";
  try {
    const prepared = await runner.step("prepare", () => steps.prepare());
    if (prepared.kind === "stop") return prepared.reason;
    let used = 1;
    if (prepared.kind === "derive") {
      for (let index = 1; index <= prepared.segments; index++) {
        current = `derive the key, part ${index}`;
        const outcome = await runner.step(`segment ${index}`, () => steps.segment(index));
        used += 1;
        if (outcome.kind === "stop") return "stopped";
      }
      current = "check the passphrase";
      const check = await runner.step("check the passphrase", () => steps.checkPassphrase());
      used += 1;
      if (check.status !== "ready")
        return check.status === "wrong" ? "wrong passphrase" : "stopped";
    }
    current = "open the backup";
    const opened = await runner.step("open the backup", () => steps.open());
    used += 1;
    if (opened.kind === "invalid") return "invalid backup";

    let position = await runner.step("read the progress", () => steps.position());
    used += 1;
    let pauses = 0;
    while (position < opened.plan.length) {
      if (used >= maxSteps) {
        current = "continue in a new Workflow instance";
        await runner.step("continue in a new instance", () => steps.continueRun());
        return "continued";
      }
      const entry = opened.plan[position];
      current = `restore ${entry?.table ?? "rows"} (chunk ${position + 1} of ${opened.plan.length})`;
      const at = position;
      const suffix = pauses > 0 ? ` (after pause ${pauses})` : "";
      const outcome = await runner.step(`chunk ${at}${suffix}`, () => steps.chunk(opened, at));
      used += 1;
      if (outcome.kind === "wait") {
        pauses += 1;
        await runner.sleepUntil(`wait for the D1 write budget ${pauses}`, outcome.resumeAt);
        used += 1;
        continue;
      }
      position += 1;
    }
    current = "finish";
    const done = await runner.step("finish", () => steps.finish(opened));
    return done.status;
  } catch (error) {
    console.error("Restore failed", current, error);
    const message =
      error instanceof BackupCryptoError || error instanceof OperationError
        ? error.message
        : "The restore stopped on an unexpected error. Try again.";
    await runner.step("mark failed", () => steps.fail(current, message));
    return "failed";
  }
}

/** The steps of one instance on fresh deps per step. */
export function restoreSteps(
  deps: <T>(work: (deps: RestoreDeps) => Promise<T>) => Promise<T>,
  job: RestoreJob,
  startNext: (job: RestoreJob) => Promise<void>,
): RestoreSteps {
  return {
    prepare: () => deps((d) => prepareRestore(d, job)),
    segment: (index) => deps((d) => restoreSegment(d, job, index)),
    checkPassphrase: () => deps((d) => checkRestorePassphrase(d, job)),
    open: () => deps((d) => openRestore(d, job)),
    chunk: (opened, position) => deps((d) => restoreChunk(d, job, opened, position)),
    finish: (opened) => deps((d) => finishRestore(d, job, opened)),
    position: () => deps((d) => restorePosition(d.db, job.runId)),
    continueRun: () =>
      deps(async (d) => {
        const generation = job.generation + 1;
        await d.db.db
          .updateTable("restore_runs")
          .set({ generation, updated_at: d.now })
          .where("id", "=", job.runId)
          .where("generation", "=", job.generation)
          .execute();
        await startNext({ runId: job.runId, generation });
      }),
    fail: (step, message) => deps((d) => failRestore(d.db, job, step, message, "failed", d.now)),
  };
}

/** The committed position of the run, for a driver that starts after a continue. */
export async function restorePosition(db: DbConnection, runId: number): Promise<number> {
  return (await readRestoreRun(db, runId))?.position ?? 0;
}

// Status -----------------------------------------------------------------------------------------

export interface RestoreTableStatus {
  table: string;
  totalRows: number;
  rowsDone: number;
  rowsSkipped: number;
}

export interface RestoreStatus {
  id: number;
  status: "deriving" | "running" | "waiting" | "succeeded" | "failed";
  source: "r2" | "upload";
  backupId: string;
  backupCreatedAt: number;
  totalRows: number;
  rowsInserted: number;
  rowsSkipped: number;
  chunkCount: number;
  chunksDone: number;
  resumeAt: number | null;
  failedStep: string | null;
  error: string | null;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Days of the Workers Free write limit that the whole restore needs. */
  estimatedDays: number;
  /** Days of the limit that the rest needs. */
  remainingDays: number;
  tables: RestoreTableStatus[];
}

/** The daily D1 writes that a restore uses on Workers Free. */
export const FREE_RESTORE_BUDGET = 100_000 - RESTORE_WRITE_RESERVE;

/** Estimated days of the Free write limit for a number of rows. */
export function estimateRestoreDays(rows: number, factor = DEFAULT_WRITE_FACTOR): number {
  if (rows <= 0) return 0;
  return Math.max(1, Math.ceil((rows * factor) / FREE_RESTORE_BUDGET));
}

/** The status of the newest restore, for the first-run screen. Null when none ran. */
export async function readRestoreStatus(db: DbConnection): Promise<RestoreStatus | null> {
  const run = await latestRestoreRun(db);
  if (!run) return null;
  const tables = await db.db
    .selectFrom("restore_tables")
    .selectAll()
    .where("run_id", "=", run.id)
    .orderBy("ord")
    .execute();
  const factor = writeFactor(run);
  return {
    id: run.id,
    status: run.status,
    source: run.source,
    backupId: run.backup_id,
    backupCreatedAt: run.backup_created_at,
    totalRows: run.total_rows,
    rowsInserted: run.rows_inserted,
    rowsSkipped: run.rows_skipped,
    chunkCount: run.chunk_count,
    chunksDone: run.position,
    resumeAt: run.resume_at,
    failedStep: run.failed_step,
    error: run.error,
    errorCode: run.error_code,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    estimatedDays: estimateRestoreDays(run.total_rows, factor),
    remainingDays:
      run.status === "succeeded"
        ? 0
        : estimateRestoreDays(run.total_rows - run.rows_inserted - run.rows_skipped, factor),
    tables: tables.map((table) => ({
      table: table.table_name,
      totalRows: table.total_rows,
      rowsDone: table.rows_done,
      rowsSkipped: table.rows_skipped,
    })),
  };
}
