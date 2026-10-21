// Backup cryptography (U4, KTD2). WebCrypto only, so the same code runs in the Worker,
// in a Workflow, and in the tests.
//
// Keys
// ----
// - Each backup has a random 32-byte data key. HKDF-SHA256 derives two AES-256-GCM keys
//   from it: one for the chunks and one for the manifest tag.
// - Each chunk is AES-256-GCM with a random 96-bit IV. The additional data binds the
//   backup id and the chunk index, so a chunk that is moved to another position or into
//   another backup fails to decrypt.
// - The manifest tag is AES-GCM over an empty plaintext with the canonical manifest as
//   the additional data (a GMAC). It binds the chunk list, the row counts, and the
//   wrapped key.
//
// Unattended wrapping
// -------------------
// The daily backup runs with no owner present, so it cannot use the passphrase. At
// passphrase setup, the passphrase derives an X25519 key pair. Envelopen stores only the
// public key, the salts, and a verifier. Each backup wraps its data key and the
// deployment secrets to the public key (ECIES):
//
//   ephemeral X25519 key pair -> ECDH with the stored public key -> HKDF-SHA256
//   (salt = ephemeral public key || recipient public key) -> AES-256-GCM over the JSON
//   payload, with the backup id as the additional data.
//
// Only the passphrase holder can derive the private key and unwrap.
//
// Why X25519 and not P-256
// ------------------------
// The private key must come deterministically from the passphrase. An X25519 private
// key is any 32 bytes: RFC 7748 clamps the scalar, so every HKDF output is a valid key
// with no bias and no rejection loop. A P-256 key would need a reduction into the curve
// order and a zero check. workerd supports X25519 in WebCrypto (deriveBits, PKCS #8
// import, and JWK export of the public point), and the tests run there. The private
// key is imported as PKCS #8 (a fixed 16-byte prefix and the 32 key bytes). Its JWK
// export gives the public key `x`.
//
// Passphrase derivation
// ---------------------
// PBKDF2-SHA256 with at least 600,000 iterations (OWASP 2023) and a random 16-byte
// salt. Deployed Workers reject PBKDF2 above 100,000 iterations in one call, so the
// derivation chains segments of at most 100,000 iterations:
//
//   X_0 = empty
//   X_i = PBKDF2-SHA256(passphrase, salt || u32be(i) || X_(i-1), n_i)
//
// Every segment keys HMAC with the passphrase, so a guess costs the full iteration
// count, the same as one PBKDF2 call with that count. HKDF then turns X_last into the
// X25519 private key.
//
// The verifier is PBKDF2-SHA256 over X_last with its own salt and a small cost. It
// depends on the full derivation, so it is not a cheaper guessing oracle than the
// public key. A restore uses it to reject a wrong passphrase with a clear message.
//
// CPU: one 600,000-iteration derivation measured about 40 ms in local workerd on an
// Apple M-series CPU, and one 100,000-iteration segment about 7 ms. Workers Free gives
// a request and a Workflow step 10 ms of CPU, so the Worker never runs the whole
// derivation at once: the key derivation Workflow runs one segment per step
// (derivation.ts). `chainedPbkdf2` is the one-shot form for tests and tools.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** OWASP 2023 minimum for PBKDF2-HMAC-SHA256. Setup always uses at least this count. */
export const BACKUP_KDF_ITERATIONS = 600_000;
/** Deployed Workers reject a PBKDF2 call above this count. */
export const PBKDF2_SEGMENT_ITERATIONS = 100_000;
/** The verifier's own cost, on top of the full derivation. */
export const VERIFIER_ITERATIONS = 1_000;
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1_024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** PKCS #8 prefix of an X25519 private key (RFC 8410), followed by the 32 key bytes. */
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

const INFO_PRIVATE_KEY = "envelopen/backup/v1/x25519";
const INFO_WRAP = "envelopen/backup/v1/wrap";
const INFO_CHUNK = "envelopen/backup/v1/chunk";
const INFO_MANIFEST = "envelopen/backup/v1/manifest";
const INFO_STATE = "envelopen/backup/v1/state";

/** The algorithm name that a wrapped key records. */
export const WRAP_ALGORITHM = "X25519-HKDF-SHA256-A256GCM";

export class BackupCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCryptoError";
  }
}

/** The passphrase does not match the stored key material. */
export class WrongPassphraseError extends BackupCryptoError {
  constructor() {
    super("The passphrase is not correct.");
    this.name = "WrongPassphraseError";
  }
}

// Encoding ----------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new BackupCryptoError("The value is not base64url.");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32be(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Constant-time comparison of two byte arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function hkdf(secret: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(0)) {
  const material = await crypto.subtle.importKey("raw", secret as Bytes, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: encoder.encode(info) },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function aesKey(secret: Uint8Array, info: string, salt?: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await hkdf(secret, info, salt), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    plaintext as Bytes,
  );
  return concat(iv, new Uint8Array(sealed));
}

async function open(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Bytes> {
  if (sealed.length < IV_BYTES + 16) throw new BackupCryptoError("The ciphertext is too short.");
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.subarray(0, IV_BYTES) as Bytes,
        additionalData: encoder.encode(aad),
      },
      key,
      sealed.subarray(IV_BYTES) as Bytes,
    );
    return new Uint8Array(opened);
  } catch {
    throw new BackupCryptoError("The data does not decrypt with this key.");
  }
}

// Passphrase -> key pair ----------------------------------------------------------------

/** Returns an error message for a passphrase that is too short or too long, or null. */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    return `Use a passphrase of ${MAX_PASSPHRASE_LENGTH} characters or fewer.`;
  }
  return null;
}

/**
 * PBKDF2-SHA256 in segments of at most `segment` iterations (see the note at the top).
 * With `iterations <= segment`, it is one PBKDF2 call over `salt || u32be(1)`.
 */
export async function chainedPbkdf2(
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  segment = PBKDF2_SEGMENT_ITERATIONS,
): Promise<Bytes> {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new BackupCryptoError("The iteration count must be a positive integer.");
  }
  let previous: Bytes = new Uint8Array(0);
  let left = iterations;
  for (let index = 1; left > 0; index++) {
    const count = Math.min(segment, left);
    previous = await pbkdf2Segment(secret, salt, index, previous, count);
    left -= count;
  }
  return previous;
}

/** The number of segments of a chained derivation. */
export function segmentCount(iterations: number, segment = PBKDF2_SEGMENT_ITERATIONS): number {
  return Math.ceil(iterations / segment);
}

/** The iteration count of segment `index` (1-based). */
export function segmentIterations(
  iterations: number,
  index: number,
  segment = PBKDF2_SEGMENT_ITERATIONS,
): number {
  return Math.max(0, Math.min(segment, iterations - (index - 1) * segment));
}

/**
 * One segment of the chained derivation: X_index from X_(index-1). The key derivation
 * Workflow runs one call per step.
 */
export async function pbkdf2Segment(
  secret: Uint8Array,
  salt: Uint8Array,
  index: number,
  previous: Uint8Array,
  count: number,
): Promise<Bytes> {
  if (!Number.isSafeInteger(count) || count < 1 || count > PBKDF2_SEGMENT_ITERATIONS) {
    throw new BackupCryptoError("A segment has 1 to 100,000 iterations.");
  }
  const material = await crypto.subtle.importKey("raw", secret as Bytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: concat(salt, u32be(index), previous),
      iterations: count,
    },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** What Envelopen stores about the passphrase. None of it reveals the passphrase. */
export interface BackupKeyMaterial {
  /** X25519 public key, base64url. */
  publicKey: string;
  kdfSalt: string;
  kdfIterations: number;
  verifier: string;
  verifierSalt: string;
  verifierIterations: number;
}

async function importPrivateKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    concat(X25519_PKCS8_PREFIX, raw),
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
}

/** The X25519 key pair of a raw 32-byte private key. */
export async function x25519FromPrivate(
  raw: Uint8Array,
): Promise<{ privateKey: CryptoKey; publicKey: Bytes }> {
  if (raw.length !== KEY_BYTES) throw new BackupCryptoError("An X25519 key has 32 bytes.");
  const privateKey = await importPrivateKey(raw);
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  if (!jwk.x) throw new BackupCryptoError("The runtime did not export the public key.");
  return { privateKey, publicKey: fromBase64Url(jwk.x) };
}

async function deriveFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  verifierSalt: Uint8Array,
  verifierIterations: number,
) {
  const master = await chainedPbkdf2(encoder.encode(passphrase), salt, iterations);
  return keysFromMaster(master, verifierSalt, verifierIterations);
}

/**
 * The key pair and the verifier from the derivation output X_last. It costs the
 * verifier's iterations (1,000) and one X25519 key import, so it fits one step.
 */
export async function keysFromMaster(
  master: Uint8Array,
  verifierSalt: Uint8Array,
  verifierIterations: number,
): Promise<{ privateKey: CryptoKey; publicKey: Bytes; verifier: Bytes }> {
  const pair = await x25519FromPrivate(await hkdf(master, INFO_PRIVATE_KEY));
  const verifier = await chainedPbkdf2(master, verifierSalt, verifierIterations);
  return { ...pair, verifier };
}

/**
 * The private key from the derivation output, checked against the stored material.
 * Throws WrongPassphraseError when the verifier or the public key does not match.
 */
export async function privateKeyFromMaster(
  master: Uint8Array,
  material: BackupKeyMaterial,
): Promise<CryptoKey> {
  const derived = await keysFromMaster(
    master,
    fromBase64Url(material.verifierSalt),
    material.verifierIterations,
  );
  if (!sameBytes(derived.verifier, fromBase64Url(material.verifier))) {
    throw new WrongPassphraseError();
  }
  if (!sameBytes(derived.publicKey, fromBase64Url(material.publicKey))) {
    throw new WrongPassphraseError();
  }
  return derived.privateKey;
}

/**
 * Derives the key material of a new passphrase. The salts are random unless the
 * caller passes them (the fixed test vectors do).
 */
export async function createKeyMaterial(
  passphrase: string,
  options: {
    iterations?: number;
    verifierIterations?: number;
    salt?: Uint8Array;
    verifierSalt?: Uint8Array;
  } = {},
): Promise<BackupKeyMaterial> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new BackupCryptoError(problem);
  const iterations = options.iterations ?? BACKUP_KDF_ITERATIONS;
  const verifierIterations = options.verifierIterations ?? VERIFIER_ITERATIONS;
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const verifierSalt = options.verifierSalt ?? randomBytes(SALT_BYTES);
  const derived = await deriveFromPassphrase(
    passphrase,
    salt,
    iterations,
    verifierSalt,
    verifierIterations,
  );
  return {
    publicKey: toBase64Url(derived.publicKey),
    kdfSalt: toBase64Url(salt),
    kdfIterations: iterations,
    verifier: toBase64Url(derived.verifier),
    verifierSalt: toBase64Url(verifierSalt),
    verifierIterations,
  };
}

/**
 * One-shot: derives the private key from the passphrase and the stored material, in one
 * call of about 40 ms CPU. Tests and tools use it. In the Worker, use the key derivation
 * Workflow (derivation.ts) and `privateKeyFromMaster`. Throws
 * WrongPassphraseError when the verifier or the public key does not match.
 */
export async function derivePrivateKey(
  passphrase: string,
  material: BackupKeyMaterial,
): Promise<CryptoKey> {
  const master = await chainedPbkdf2(
    encoder.encode(passphrase),
    fromBase64Url(material.kdfSalt),
    material.kdfIterations,
  );
  return privateKeyFromMaster(master, material);
}

// Data key and chunks ---------------------------------------------------------------------

export function generateDataKey(): Bytes {
  return randomBytes(KEY_BYTES);
}

function chunkAad(backupId: string, index: number): string {
  return `envelopen-backup:v1:chunk:${backupId}:${index}`;
}

/** Encrypts one chunk. The output is the IV followed by the ciphertext and the tag. */
export async function encryptChunk(
  dataKey: Uint8Array,
  backupId: string,
  index: number,
  plaintext: Uint8Array,
): Promise<Bytes> {
  return seal(await aesKey(dataKey, INFO_CHUNK), plaintext, chunkAad(backupId, index));
}

/** Decrypts one chunk. Throws for a chunk from another position or backup. */
export async function decryptChunk(
  dataKey: Uint8Array,
  backupId: string,
  index: number,
  sealed: Uint8Array,
): Promise<Bytes> {
  return open(await aesKey(dataKey, INFO_CHUNK), sealed, chunkAad(backupId, index));
}

/** AES-GCM tag (GMAC) over `data`, under the manifest key of the data key. */
export async function computeTag(dataKey: Uint8Array, data: string): Promise<string> {
  return toBase64Url(await seal(await aesKey(dataKey, INFO_MANIFEST), new Uint8Array(0), data));
}

/** True when the tag matches `data` under the data key. */
export async function checkTag(dataKey: Uint8Array, data: string, tag: string): Promise<boolean> {
  try {
    const opened = await open(await aesKey(dataKey, INFO_MANIFEST), fromBase64Url(tag), data);
    return opened.length === 0;
  } catch {
    return false;
  }
}

// Wrapping to the public key ------------------------------------------------------------

/**
 * The deployment secrets that keyed data depends on (R3). A restore into a new
 * deployment needs them, so suppressions and old unsubscribe links keep working.
 */
export interface DeploymentSecrets {
  signingKey: string | null;
  signingKeysRetired: string | null;
  encryptionKey: string | null;
  /** The pinned suppression hash key id from `system_settings`. */
  suppressionKeyId: string | null;
}

export interface WrappedKey {
  alg: typeof WRAP_ALGORITHM;
  /** The ephemeral X25519 public key, base64url. */
  epk: string;
  /** IV, ciphertext, and tag, base64url. */
  ct: string;
}

export interface UnwrappedKey {
  dataKey: Bytes;
  secrets: DeploymentSecrets;
}

function wrapAad(backupId: string): string {
  return `envelopen-backup:v1:wrap:${backupId}`;
}

async function wrapKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array) {
  return aesKey(shared, INFO_WRAP, concat(epk, recipient));
}

/** Wraps the data key and the secrets to the stored public key. No passphrase needed. */
export async function wrapForRecipient(
  publicKey: string,
  backupId: string,
  payload: { dataKey: Uint8Array; secrets: DeploymentSecrets },
): Promise<WrappedKey> {
  const recipientRaw = fromBase64Url(publicKey);
  const recipient = await crypto.subtle.importKey(
    "raw",
    recipientRaw,
    { name: "X25519" },
    false,
    [],
  );
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );
  const body = encoder.encode(
    JSON.stringify({ dataKey: toBase64Url(payload.dataKey), secrets: payload.secrets }),
  );
  const sealed = await seal(await wrapKey(shared, epk, recipientRaw), body, wrapAad(backupId));
  return { alg: WRAP_ALGORITHM, epk: toBase64Url(epk), ct: toBase64Url(sealed) };
}

/**
 * One-shot: opens a wrapped key with the passphrase (see derivePrivateKey). In the
 * Worker, U5 restore and download derive in steps (derivation.ts), then call
 * `unwrapWithPrivateKey`. Throws
 * WrongPassphraseError for a wrong passphrase, and BackupCryptoError for a wrapped key
 * of another backup or a changed one.
 */
export async function unwrap(
  wrapped: WrappedKey,
  backupId: string,
  passphrase: string,
  material: BackupKeyMaterial,
): Promise<UnwrappedKey> {
  if (wrapped.alg !== WRAP_ALGORITHM) throw new BackupCryptoError("Unknown wrap algorithm.");
  const privateKey = await derivePrivateKey(passphrase, material);
  return unwrapWithPrivateKey(wrapped, backupId, privateKey, fromBase64Url(material.publicKey));
}

/** Opens a wrapped key with a private key that `derivePrivateKey` returned. */
export async function unwrapWithPrivateKey(
  wrapped: WrappedKey,
  backupId: string,
  privateKey: CryptoKey,
  recipientRaw: Uint8Array,
): Promise<UnwrappedKey> {
  const epkRaw = fromBase64Url(wrapped.epk);
  const epk = await crypto.subtle.importKey("raw", epkRaw, { name: "X25519" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: epk } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      privateKey,
      256,
    ),
  );
  const opened = await open(
    await wrapKey(shared, epkRaw, recipientRaw),
    fromBase64Url(wrapped.ct),
    wrapAad(backupId),
  );
  const parsed = JSON.parse(decoder.decode(opened)) as {
    dataKey: string;
    secrets: DeploymentSecrets;
  };
  return { dataKey: fromBase64Url(parsed.dataKey), secrets: parsed.secrets };
}

// Workflow state ------------------------------------------------------------------------

/**
 * Seals the data key for the Workflow state. Steps pass it between them, and Workflows
 * store step results, so the key never rests there in plain form. The key comes from
 * ENCRYPTION_KEY through HKDF with its own label.
 */
export async function sealDataKey(
  encryptionKey: string,
  backupId: string,
  dataKey: Uint8Array,
): Promise<string> {
  return toBase64Url(await seal(await stateKey(encryptionKey), dataKey, `state:${backupId}`));
}

export async function openDataKey(
  encryptionKey: string,
  backupId: string,
  sealed: string,
): Promise<Bytes> {
  return open(await stateKey(encryptionKey), fromBase64Url(sealed), `state:${backupId}`);
}

async function stateKey(encryptionKey: string): Promise<CryptoKey> {
  let secret: Uint8Array;
  try {
    secret = fromBase64Url(
      encryptionKey.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
  } catch {
    throw new BackupCryptoError("ENCRYPTION_KEY is not valid base64.");
  }
  if (secret.length < KEY_BYTES) {
    throw new BackupCryptoError("ENCRYPTION_KEY is missing or shorter than 32 bytes of base64.");
  }
  return aesKey(secret, INFO_STATE);
}
