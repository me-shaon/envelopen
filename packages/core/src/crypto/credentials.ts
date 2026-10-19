// Provider credentials at rest (R11, KTD28): AES-256-GCM with a random 96-bit IV per
// value. Each row stores the key version that encrypted it, so a new ENCRYPTION_KEY can
// join as a new version while old rows still decrypt.
//
// The AES key comes from ENCRYPTION_KEY through HKDF with its own label. The additional
// data binds each ciphertext to its workspace and purpose, so a ciphertext copied into
// another row or workspace fails to decrypt.

const HKDF_INFO = "envelopen/credentials/v1";
const IV_BYTES = 12;

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyError";
  }
}

export interface CredentialKey {
  version: number;
  /** Base64, at least 32 bytes. */
  secret: string;
}

/** What a ciphertext belongs to. Decryption fails for any other owner. */
export interface CredentialOwner {
  workspaceId: number;
  purpose: "credentials" | "webhook_secret";
}

export interface CredentialCipher {
  /** The version that `encrypt` uses. Store it with the ciphertext. */
  readonly version: number;
  encrypt(plaintext: string, owner: CredentialOwner): Promise<string>;
  /** Throws when the version is unknown or the ciphertext or owner do not match. */
  decrypt(ciphertext: string, version: number, owner: CredentialOwner): Promise<string>;
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function deriveAesKey(secretBase64: string): Promise<CryptoKey> {
  const secret = decodeBase64(secretBase64);
  if (!secret || secret.length < 32) {
    throw new CredentialKeyError("ENCRYPTION_KEY is missing or shorter than 32 bytes of base64.");
  }
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(owner: CredentialOwner): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `envelopen:${owner.workspaceId}:${owner.purpose}`,
  ) as Uint8Array<ArrayBuffer>;
}

/**
 * Creates the cipher from a key ring. The highest version encrypts. Every version
 * decrypts the rows that carry it.
 */
export async function createCredentialCipher(
  keys: readonly CredentialKey[],
): Promise<CredentialCipher> {
  if (keys.length === 0) throw new CredentialKeyError("No encryption key is configured.");
  const ring = new Map<number, CryptoKey>();
  for (const key of keys) {
    if (!Number.isSafeInteger(key.version) || key.version < 1) {
      throw new CredentialKeyError("A key version must be a positive integer.");
    }
    ring.set(key.version, await deriveAesKey(key.secret));
  }
  const version = Math.max(...ring.keys());
  const current = ring.get(version) as CryptoKey;

  return {
    version,
    async encrypt(plaintext, owner) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(owner) },
        current,
        new TextEncoder().encode(plaintext),
      );
      return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(sealed))}`;
    },
    async decrypt(ciphertext, keyVersion, owner) {
      const key = ring.get(keyVersion);
      if (!key) throw new CredentialKeyError(`No key for version ${keyVersion}.`);
      const [ivText, bodyText] = ciphertext.split(".");
      const iv = ivText ? decodeBase64(ivText) : null;
      const body = bodyText ? decodeBase64(bodyText) : null;
      if (!iv || iv.length !== IV_BYTES || !body) {
        throw new CredentialKeyError("The stored ciphertext is not valid.");
      }
      try {
        const opened = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: additionalData(owner) },
          key,
          body,
        );
        return new TextDecoder().decode(opened);
      } catch {
        throw new CredentialKeyError("The stored credentials do not decrypt with this key.");
      }
    },
  };
}
