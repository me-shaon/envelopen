// Signed recipient tokens for tracking and unsubscribe links (KTD26, KTD28).
//
// One token per recipient of a campaign: `<kid>.<campaign>.<recipient>.<mac>`.
// - `kid` names the signing key. It is derived from the key, so it needs no setting.
// - The ids are base36. The MAC is HMAC-SHA256 over the version and the other fields,
//   truncated to 128 bits, base64url.
// - The token has no time and no randomness, so a retry of a batch builds the same
//   bytes (KTD18 idempotent retries).
//
// Keys come from SIGNING_KEY through HKDF with a versioned label, so they stay apart
// from the session, suppression, and file-link keys. Verification accepts every key in
// the ring: after a rotation, the old SIGNING_KEY joins as a retired key, and the
// unsubscribe links in old emails keep working. A new label version works the same
// way: add the old label as a retired key.

/** The HKDF label of the current token keys. */
export const TOKEN_KEY_LABEL = "envelopen/tokens/v1";
const KEY_ID_LABEL = "envelopen/tokens/key-id/v1";
const FORMAT = "t1";
const MAC_BYTES = 16;

export interface TokenKey {
  /** Base64, at least 32 bytes. */
  secret: string;
  /** The HKDF label. Defaults to TOKEN_KEY_LABEL. */
  label?: string;
}

export interface RecipientRef {
  campaignId: number;
  recipientId: number;
}

export interface VerifiedToken extends RecipientRef {
  keyId: string;
  /** True when a retired key signed the token. */
  retired: boolean;
}

export interface TokenSigner {
  /** The key id that `sign` uses. */
  readonly keyId: string;
  sign(ref: RecipientRef): Promise<string>;
  /** Returns the recipient of a valid token, or null for anything else. */
  verify(token: string): Promise<VerifiedToken | null>;
}

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenKeyError";
  }
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();

interface RingKey {
  id: string;
  key: CryptoKey;
}

async function deriveRingKey(entry: TokenKey): Promise<RingKey> {
  const secret = decodeBase64(entry.secret);
  if (!secret || secret.length < 32) {
    throw new TokenKeyError("A signing key is missing or shorter than 32 bytes of base64.");
  }
  const label = entry.label ?? TOKEN_KEY_LABEL;
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const key = await crypto.subtle.deriveKey(
    hkdf(label),
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  // The key id is a separate derivation of the same secret and label, so it reveals
  // nothing about the signing key. 6 bytes keep it short and collisions unlikely.
  const idBits = await crypto.subtle.deriveBits(hkdf(`${KEY_ID_LABEL}|${label}`), material, 48);
  return { id: toBase64Url(new Uint8Array(idBits)), key };
}

const ID = /^[1-9a-z][0-9a-z]{0,12}$/;

function parseId(text: string): number | null {
  if (!ID.test(text)) return null;
  const value = Number.parseInt(text, 36);
  return Number.isSafeInteger(value) ? value : null;
}

async function mac(key: CryptoKey, body: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${FORMAT}.${body}`));
  return toBase64Url(new Uint8Array(signature, 0, MAC_BYTES));
}

/** Compares two strings in time that depends only on their length. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Creates the signer from a key ring. The first key signs. Every key verifies.
 * Derive it once per isolate: the HKDF work is the slow part.
 */
export async function createTokenSigner(keys: readonly TokenKey[]): Promise<TokenSigner> {
  if (keys.length === 0) throw new TokenKeyError("No signing key is configured.");
  const ring = await Promise.all(keys.map(deriveRingKey));
  const current = ring[0] as RingKey;
  const byId = new Map<string, { key: CryptoKey; retired: boolean }>();
  ring.forEach((entry, index) => {
    if (!byId.has(entry.id)) byId.set(entry.id, { key: entry.key, retired: index > 0 });
  });

  return {
    keyId: current.id,
    async sign({ campaignId, recipientId }) {
      if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
        throw new RangeError("The campaign id must be a positive integer.");
      }
      if (!Number.isSafeInteger(recipientId) || recipientId < 1) {
        throw new RangeError("The recipient id must be a positive integer.");
      }
      const body = `${current.id}.${campaignId.toString(36)}.${recipientId.toString(36)}`;
      return `${body}.${await mac(current.key, body)}`;
    },
    async verify(token) {
      if (token.length > 120) return null;
      const fields = token.split(".");
      if (fields.length !== 4) return null;
      const [keyId, campaignText, recipientText, signature] = fields as [
        string,
        string,
        string,
        string,
      ];
      const entry = byId.get(keyId);
      const campaignId = parseId(campaignText);
      const recipientId = parseId(recipientText);
      if (!entry || campaignId === null || recipientId === null) return null;
      const expected = await mac(entry.key, `${keyId}.${campaignText}.${recipientText}`);
      if (!sameText(expected, signature)) return null;
      return { keyId, campaignId, recipientId, retired: entry.retired };
    },
  };
}

/**
 * The key ring from the Worker's secrets: SIGNING_KEY signs, and the comma-separated
 * SIGNING_KEYS_RETIRED (old SIGNING_KEY values) still verify.
 */
export function tokenKeysFromEnv(current: string, retired?: string): TokenKey[] {
  const old = (retired ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== current.trim());
  return [{ secret: current }, ...old.map((secret) => ({ secret }))];
}
