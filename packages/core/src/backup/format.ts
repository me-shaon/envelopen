import { TABLE_SCOPE, type TableName } from "@envelopen/db";
import {
  BackupCryptoError,
  type BackupKeyMaterial,
  checkTag,
  computeTag,
  type WrappedKey,
} from "./crypto";

// The backup format (U4, KTD2). A backup is a folder `backups/<backupId>/` with:
//
// - `chunks/<index>.bin`: about CHUNK_ROWS rows of one table as NDJSON (one JSON object
//   per row, column name to value), encrypted with the data key (crypto.ts).
// - `manifest.json`: plain JSON. It says what the backup holds, carries the wrapped
//   data key and secrets, and has an AEAD tag under the data key over all of it.
//
// Consistency: at the start, the run records the highest rowid of each table. Chunks
// page by rowid up to that mark, so rows inserted during the run are not in the backup.
// Rows updated during the run can still change (KTD2).
//
// Values are kept exactly. SQLite gives integers, reals, text, null, and blobs. A blob
// is written as {"$b64": "<base64url>"}. No other value is a JSON object, so the
// marker cannot clash with a text value.

export const BACKUP_FORMAT_VERSION = 1;
/**
 * The schema of the backed-up data: the number of the latest D1 migration. A restore
 * refuses a newer backup, and migrates an older one first (U5). A test keeps it equal
 * to the highest migration file.
 */
export const BACKUP_SCHEMA_VERSION = 16;
/** Rows per chunk. A chunk of 1,000 rows encrypts in a few milliseconds of CPU. */
export const CHUNK_ROWS = 1_000;

/**
 * Tables that are not in a backup, with the reason. Every other table of TABLE_SCOPE is.
 * - auth_session: live session tokens. A restore signs every user out anyway (KTD3).
 * - backup_runs: the history of this deployment's backups, not data to restore.
 * - key_derivations: passphrase derivations in progress, with sealed secrets.
 */
export const BACKUP_EXCLUDED_TABLES: Readonly<Partial<Record<TableName, string>>> = {
  auth_session: "Session tokens. A restore signs every user out.",
  backup_runs: "The backup history of the source deployment.",
  key_derivations: "Short-lived passphrase derivations with sealed secrets.",
};

/** The tables in a backup, in TABLE_SCOPE order. */
export const BACKUP_TABLES: readonly TableName[] = (Object.keys(TABLE_SCOPE) as TableName[]).filter(
  (table) => !(table in BACKUP_EXCLUDED_TABLES),
);

export interface ManifestTable {
  name: TableName;
  scope: "global" | "tenant";
  /** The highest rowid at the start of the run, or null for an empty table. */
  highWaterMark: number | null;
  /** The rows in the backup. */
  rows: number;
}

export interface ManifestChunk {
  index: number;
  table: TableName;
  /** The object key, relative to the backup folder. */
  key: string;
  rows: number;
  firstRowid: number;
  lastRowid: number;
  /** Size of the encrypted object in bytes. */
  bytes: number;
  /** SHA-256 of the encrypted object, base64url. */
  sha256: string;
}

export interface ManifestBody {
  format: typeof BACKUP_FORMAT_VERSION;
  schemaVersion: number;
  backupId: string;
  /** Unix milliseconds of the start of the run. */
  createdAt: number;
  tables: ManifestTable[];
  chunks: ManifestChunk[];
  totalRows: number;
  /** The data key and the deployment secrets, wrapped to the passphrase's public key. */
  wrappedKey: WrappedKey;
  /**
   * The public key that `wrappedKey` is wrapped to, with the salts, the costs, and the
   * verifier of the passphrase. None of it is secret. A restore into a new deployment has
   * no settings row, so it derives the private key from these values.
   */
  keyMaterial: BackupKeyMaterial;
}

export interface Manifest extends ManifestBody {
  /** AES-GCM tag under the data key over the canonical body. */
  tag: string;
}

export function backupPrefix(backupId: string): string {
  return `backups/${backupId}/`;
}

export function chunkKey(index: number): string {
  return `chunks/${String(index).padStart(6, "0")}.bin`;
}

export const MANIFEST_KEY = "manifest.json";

/** JSON with object keys sorted at every level, so the same body gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function tagData(body: ManifestBody): string {
  return `envelopen-backup:v1:manifest:${canonicalJson(body)}`;
}

/** Adds the AEAD tag to a manifest body. */
export async function signManifest(body: ManifestBody, dataKey: Uint8Array): Promise<Manifest> {
  return { ...body, tag: await computeTag(dataKey, tagData(body)) };
}

/**
 * Checks the manifest tag under the data key (U5 restore runs it before any write).
 * Throws when any field of the manifest changed.
 */
export async function verifyManifest(manifest: Manifest, dataKey: Uint8Array): Promise<void> {
  const { tag, ...body } = manifest;
  if (typeof tag !== "string" || !(await checkTag(dataKey, tagData(body), tag))) {
    throw new BackupCryptoError("The backup manifest was changed or is not for this key.");
  }
  if (manifest.format !== BACKUP_FORMAT_VERSION) {
    throw new BackupCryptoError(`Unknown backup format ${String(manifest.format)}.`);
  }
}

// Rows ------------------------------------------------------------------------------

export type BackupValue = string | number | null | { $b64: string };
export type BackupRow = Record<string, BackupValue>;

function blobToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeValue(value: unknown): BackupValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return { $b64: blobToBase64Url(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      $b64: blobToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  // D1 can return a blob as an array of byte values.
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return { $b64: blobToBase64Url(Uint8Array.from(value as number[])) };
  }
  throw new Error(`A column value of type ${typeof value} cannot be backed up.`);
}

/** Decodes a value that `encodeRows` wrote. A blob comes back as a Uint8Array. */
export function decodeValue(value: BackupValue): string | number | null | Uint8Array {
  if (value !== null && typeof value === "object") {
    const padded = value.$b64.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return value;
}

/** NDJSON of the rows, one line per row. */
export function encodeRows(rows: readonly Record<string, unknown>[]): Uint8Array {
  const lines = rows.map((row) => {
    const out: BackupRow = {};
    for (const [column, value] of Object.entries(row)) out[column] = encodeValue(value);
    return JSON.stringify(out);
  });
  return new TextEncoder().encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

export function decodeRows(bytes: Uint8Array): BackupRow[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as BackupRow);
}

export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return blobToBase64Url(new Uint8Array(digest));
}
