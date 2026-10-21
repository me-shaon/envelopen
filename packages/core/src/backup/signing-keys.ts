import type { DbConnection } from "@envelopen/db";
import type { CredentialCipher, CredentialOwner } from "../crypto/credentials";
import type { SettingsCache } from "../services";
import { signingKeyRing } from "../suppression/hash";

// Signing keys that a restore imported (U5, KTD3, R3).
//
// Unsubscribe links in sent emails and the suppression hashes were made with the
// SIGNING_KEY of the deployment that made the backup. A restore into a deployment with
// another SIGNING_KEY imports the backup's keys, so old links verify and restored
// suppressions keep matching. The token signer and the suppression hasher read the key
// ring in this order: env SIGNING_KEY, then SIGNING_KEYS_RETIRED, then the imported
// keys (suppression/hash.ts signingKeyRing). SIGNING_KEY still signs every new token.
//
// The keys are secrets, so `system_settings` holds them encrypted with ENCRYPTION_KEY,
// as provider credentials are:
//   {"v": <key version>, "c": <ciphertext of a JSON array of base64 keys>}

export const IMPORTED_SIGNING_KEYS_SETTING = "imported_signing_keys";
/** The value that the settings cache holds when no key was imported. */
export const NO_IMPORTED_KEYS = "none";

const OWNER: CredentialOwner = {
  workspaceId: 0,
  purpose: "imported_signing_keys",
  connectionId: 1,
};

/** The stored setting value of a key list. */
export async function encryptImportedKeys(
  cipher: CredentialCipher,
  keys: readonly string[],
): Promise<string> {
  return JSON.stringify({
    v: cipher.version,
    c: await cipher.encrypt(JSON.stringify(keys), OWNER),
  });
}

/** The keys of a stored setting value. Throws when it does not decrypt. */
export async function decryptImportedKeys(
  cipher: CredentialCipher,
  value: string,
): Promise<string[]> {
  if (value === NO_IMPORTED_KEYS) return [];
  const parsed = JSON.parse(value) as { v?: unknown; c?: unknown };
  if (typeof parsed.v !== "number" || typeof parsed.c !== "string") {
    throw new Error("The imported signing keys are not valid.");
  }
  const keys = JSON.parse(await cipher.decrypt(parsed.c, parsed.v, OWNER)) as unknown;
  if (!Array.isArray(keys)) throw new Error("The imported signing keys are not valid.");
  return keys.filter((key): key is string => typeof key === "string" && key.length > 0);
}

/** The stored setting value, or null when no key was imported. */
export async function readImportedKeysValue(db: DbConnection): Promise<string | null> {
  const row = await db.db
    .selectFrom("system_settings")
    .select("value")
    .where("key", "=", IMPORTED_SIGNING_KEYS_SETTING)
    .executeTakeFirst();
  return row?.value ?? null;
}

/**
 * The imported keys. It reads the settings cache first, so the public routes need no
 * D1 read in the common case, also at the D1 daily limit.
 */
export async function readImportedSigningKeys(
  db: DbConnection,
  cipher: CredentialCipher,
  cache?: SettingsCache,
): Promise<string[]> {
  let value: string | null = null;
  try {
    value = (await cache?.get(IMPORTED_SIGNING_KEYS_SETTING)) ?? null;
  } catch (error) {
    console.error("The settings cache read failed", error);
  }
  if (value === null) {
    value = (await readImportedKeysValue(db)) ?? NO_IMPORTED_KEYS;
    try {
      await cache?.put(IMPORTED_SIGNING_KEYS_SETTING, value);
    } catch (error) {
      console.error("The settings cache write failed", error);
    }
  }
  return decryptImportedKeys(cipher, value);
}

/**
 * The keys of a backup that this deployment must import: the backup's SIGNING_KEY and
 * retired keys that are not already in this deployment's env.
 */
export function keysToImport(
  backup: { signingKey: string | null; signingKeysRetired: string | null },
  env: { signingKey?: string | undefined; signingKeysRetired?: string | undefined },
): string[] {
  const own = env.signingKey ? signingKeyRing(env.signingKey, env.signingKeysRetired) : [];
  const theirs = backup.signingKey
    ? signingKeyRing(backup.signingKey, backup.signingKeysRetired ?? undefined)
    : signingKeyRing("", backup.signingKeysRetired ?? undefined);
  return theirs.filter((key) => !own.includes(key));
}
