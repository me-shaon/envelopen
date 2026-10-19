import type { EmailHasher } from "../services";

// Suppressions key on an HMAC of the normalized address, so a suppression survives a
// contact erase without the address (R19, R21). The key comes from a SIGNING_KEY through
// HKDF with its own label, so it is separate from the token and session keys.
//
// The hash must stay stable. An erased contact leaves only its hash, so a rehash with a
// new key is not possible. The installation pins one hash key instead: the first use
// stores the key id in `system_settings`, and every later use hashes with that key.
// After a rotation, the old SIGNING_KEY stays in SIGNING_KEYS_RETIRED, and the pinned
// key is found there. If the pinned key is in neither secret, hashing fails, so no
// suppression check can pass by mistake.

const HKDF_INFO = "envelopen/suppression/v1";
const KEY_ID_INFO = "envelopen/suppression/key-id/v1";
/** The `system_settings` key that holds the id of the pinned hash key. */
export const SUPPRESSION_KEY_SETTING = "suppression_hash_key_id";
/** How many contacts the first use checks to find the key of the existing hashes. */
const PIN_SAMPLE = 5;

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Derives a 256-bit HMAC key with HKDF-SHA256 from a base64 secret of at least 32 bytes. */
export async function deriveHmacKey(secretBase64: string, info: string): Promise<CryptoKey> {
  const secret = decodeBase64(secretBase64);
  if (!secret || secret.length < 32) {
    throw new Error("SIGNING_KEY is missing or shorter than 32 bytes of base64.");
  }
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** A short public id of a secret for one HKDF label. It does not reveal the key. */
async function deriveKeyId(secretBase64: string, info: string): Promise<string> {
  const secret = decodeBase64(secretBase64);
  if (!secret || secret.length < 32) {
    throw new Error("SIGNING_KEY is missing or shorter than 32 bytes of base64.");
  }
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    material,
    64,
  );
  return toHex(bits);
}

/** HMAC-SHA256 of a text as lowercase hex. */
export async function hmacHex(key: CryptoKey, text: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** The email hasher for suppressions, keyed from SIGNING_KEY. Normalize the address first. */
export async function createEmailHasher(signingKey: string): Promise<EmailHasher> {
  const key = await deriveHmacKey(signingKey, HKDF_INFO);
  return (normalizedEmail) => hmacHex(key, normalizedEmail);
}

/** Thrown when the pinned suppression hash key is not in SIGNING_KEY or SIGNING_KEYS_RETIRED. */
export class SuppressionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuppressionKeyError";
  }
}

interface RingEntry {
  id: string;
  key: CryptoKey;
}

/**
 * The email hasher for suppressions with a pinned key (see the note at the top).
 * `secrets` is the key ring: SIGNING_KEY first, then the retired keys.
 *
 * The first use pins a key. When contacts with a hash exist, it pins the ring key that
 * made their hashes, so a rotation before the first use is safe too. When no ring key
 * made them, it fails instead of pinning a key that matches no suppression.
 */
export async function createPinnedEmailHasher(
  db: D1Database,
  secrets: readonly string[],
): Promise<EmailHasher> {
  const ring: RingEntry[] = await Promise.all(
    secrets.map(async (secret) => ({
      id: await deriveKeyId(secret, KEY_ID_INFO),
      key: await deriveHmacKey(secret, HKDF_INFO),
    })),
  );
  const current = ring[0];
  if (!current) throw new Error("SIGNING_KEY is missing.");

  const readPin = async () =>
    (
      await db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .bind(SUPPRESSION_KEY_SETTING)
        .first<{ value: string }>()
    )?.value ?? null;

  let pinned = await readPin();
  if (pinned === null) {
    const choice = await keyOfExistingHashes(db, ring);
    await db
      .prepare(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      )
      .bind(SUPPRESSION_KEY_SETTING, choice.id)
      .run();
    // Another isolate can pin first. Its choice wins.
    pinned = (await readPin()) ?? choice.id;
  }

  const entry = ring.find((candidate) => candidate.id === pinned);
  if (!entry) {
    throw new SuppressionKeyError(
      "The suppression hash key is not in SIGNING_KEY or SIGNING_KEYS_RETIRED. " +
        "Add the earlier SIGNING_KEY to SIGNING_KEYS_RETIRED.",
    );
  }
  return (normalizedEmail) => hmacHex(entry.key, normalizedEmail);
}

/** The ring key that made the stored contact hashes, or SIGNING_KEY when there are none. */
async function keyOfExistingHashes(db: D1Database, ring: RingEntry[]): Promise<RingEntry> {
  // An installation-wide check before any workspace is known, so it reads every workspace.
  const { results } = await db
    .prepare(
      "SELECT email, email_hash FROM contacts WHERE email_hash IS NOT NULL AND email IS NOT NULL LIMIT ?",
    )
    .bind(PIN_SAMPLE)
    .all<{ email: string; email_hash: string }>();
  if (results.length === 0) return ring[0] as RingEntry;
  for (const entry of ring) {
    let matches = true;
    for (const row of results) {
      if ((await hmacHex(entry.key, row.email)) !== row.email_hash) {
        matches = false;
        break;
      }
    }
    if (matches) return entry;
  }
  throw new SuppressionKeyError(
    "The stored suppression hashes match no key in SIGNING_KEY or SIGNING_KEYS_RETIRED. " +
      "Add the earlier SIGNING_KEY to SIGNING_KEYS_RETIRED.",
  );
}
