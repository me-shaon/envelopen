import type { DbConnection, Row } from "@envelopen/db";
import { z } from "zod";
import type { CredentialCipher, CredentialOwner } from "../crypto/credentials";
import { isHttpsUrl } from "../settings/operations";
import type { BackupKeyMaterial } from "./crypto";

// Backup settings and runs in D1 (U4). Both tables are global (0016_backups.sql).

/** Retention when the owner has not set one (R2). */
export const DEFAULT_RETENTION_DAYS = 14;
export const BACKUP_MAX_RETENTION_DAYS = 365;
/**
 * D1 rows that backups may read per UTC day, over all runs. Workers Free allows
 * 5,000,000 rows read per day. Backups take at most 40%, so the admin app, the public
 * pages, and the send path keep 3,000,000 (KTD2).
 */
export const BACKUP_READ_BUDGET = 2_000_000;
/** The UTC hour and minute of the daily backup (apps/worker/src/cron.ts). */
export const BACKUP_HOUR = 2;
export const BACKUP_MINUTE = 23;

/** The next daily backup time after `now`. */
export function nextBackupAt(now: number): number {
  const date = new Date(now);
  const today = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    BACKUP_HOUR,
    BACKUP_MINUTE,
  );
  return today > now ? today : today + 24 * 60 * 60 * 1000;
}

/** A run still marked `running` after this long is treated as stopped. */
export const STALE_RUN_MS = 2 * 24 * 60 * 60 * 1000;

const SETTINGS_ID = 1;
/** The credentials cipher binds the S3 destination to this owner. */
const S3_OWNER: CredentialOwner = {
  workspaceId: 0,
  purpose: "backup_destination",
  connectionId: SETTINGS_ID,
};

export type BackupSettingsRow = Row<"backup_settings">;
export type BackupRunRow = Row<"backup_runs">;

/** An S3-compatible store that gets a copy of each backup. */
export const S3DestinationSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .refine(isHttpsUrl, "Enter the endpoint as a full URL that starts with https://.")
    .transform((value) => value.replace(/\/+$/, ""))
    .meta({ description: "The S3 endpoint, for example https://s3.eu-central-1.amazonaws.com." }),
  region: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,64}$/, "Enter a region such as us-east-1 or auto.")
    .meta({ description: "The region for request signing, for example us-east-1 or auto." }),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Enter a valid bucket name.")
    .meta({ description: "The bucket name." }),
  accessKeyId: z.string().trim().min(1, "Enter the access key id.").max(128),
  secretAccessKey: z.string().min(1, "Enter the secret access key.").max(256),
});
export type S3Destination = z.output<typeof S3DestinationSchema>;

/** Reads the settings row. Returns null before anything is set. */
export async function readBackupSettings(db: DbConnection): Promise<BackupSettingsRow | null> {
  const row = await db.db
    .selectFrom("backup_settings")
    .selectAll()
    .where("id", "=", SETTINGS_ID)
    .executeTakeFirst();
  return row ?? null;
}

/** The stored key material, or null when no passphrase is set. */
export function keyMaterialOf(row: BackupSettingsRow | null): BackupKeyMaterial | null {
  if (
    !row?.public_key ||
    !row.kdf_salt ||
    !row.kdf_iterations ||
    !row.verifier ||
    !row.verifier_salt ||
    !row.verifier_iterations
  ) {
    return null;
  }
  return {
    publicKey: row.public_key,
    kdfSalt: row.kdf_salt,
    kdfIterations: row.kdf_iterations,
    verifier: row.verifier,
    verifierSalt: row.verifier_salt,
    verifierIterations: row.verifier_iterations,
  };
}

type SettingsChange = Partial<Omit<BackupSettingsRow, "id">>;

/** Inserts the settings row or changes the given columns. */
export async function writeBackupSettings(
  db: DbConnection,
  change: SettingsChange,
  now: number,
): Promise<void> {
  const values = { ...change, updated_at: now };
  await db.db
    .insertInto("backup_settings")
    .values({ id: SETTINGS_ID, ...values })
    .onConflict((oc) => oc.column("id").doUpdateSet(values))
    .execute();
}

export async function encryptS3Destination(
  cipher: CredentialCipher,
  destination: S3Destination,
): Promise<{ s3_config: string; s3_key_version: number }> {
  return {
    s3_config: await cipher.encrypt(JSON.stringify(destination), S3_OWNER),
    s3_key_version: cipher.version,
  };
}

/** The stored S3 destination, decrypted, or null when none is set. */
export async function decryptS3Destination(
  cipher: CredentialCipher | undefined,
  row: BackupSettingsRow | null,
): Promise<S3Destination | null> {
  if (!row?.s3_config || row.s3_key_version === null) return null;
  if (!cipher) throw new Error("ENCRYPTION_KEY is missing, so the S3 settings cannot be read.");
  const text = await cipher.decrypt(row.s3_config, row.s3_key_version, S3_OWNER);
  return S3DestinationSchema.parse(JSON.parse(text));
}

export function parseDestinations(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** D1 rows that all backup runs read on the UTC day. */
export async function rowsReadOnDay(db: DbConnection, day: string): Promise<number> {
  const row = await db.db
    .selectFrom("backup_runs")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("rows_read_day"), eb.lit(0)).as("total"))
    .where("read_day", "=", day)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/** The newest run that is still running and not stale, or undefined. */
export async function activeRun(db: DbConnection, now: number): Promise<BackupRunRow | undefined> {
  return db.db
    .selectFrom("backup_runs")
    .selectAll()
    .where("status", "=", "running")
    .where("started_at", ">", now - STALE_RUN_MS)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
}
