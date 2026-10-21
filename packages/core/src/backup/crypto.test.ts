import { describe, expect, it } from "vitest";
import {
  BACKUP_KDF_ITERATIONS,
  BackupCryptoError,
  chainedPbkdf2,
  createKeyMaterial,
  type DeploymentSecrets,
  decryptChunk,
  derivePrivateKey,
  encryptChunk,
  fromBase64Url,
  generateDataKey,
  openDataKey,
  sealDataKey,
  toBase64Url,
  unwrap,
  WrongPassphraseError,
  wrapForRecipient,
  x25519FromPrivate,
} from "./crypto";

// Backup cryptography with fixed vectors (U4, KTD2).

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const PASSPHRASE = "correct horse battery staple";
const SALT = new Uint8Array(16).fill(1);
const VERIFIER_SALT = new Uint8Array(16).fill(2);
const SECRETS: DeploymentSecrets = {
  signingKey: "c2lnbmluZw==",
  signingKeysRetired: "b2xkLWtleQ==",
  encryptionKey: "ZW5jcnlwdGlvbg==",
  suppressionKeyId: "k1",
};

async function pbkdf2(secret: Uint8Array, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
      key,
      256,
    ),
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail.");
}

describe("chained PBKDF2", () => {
  it("is one PBKDF2 call over salt || u32be(1) when the count fits one segment", async () => {
    const secret = new TextEncoder().encode(PASSPHRASE);
    const expected = await pbkdf2(secret, new Uint8Array([...SALT, 0, 0, 0, 1]), 1000);
    expect(toHex(await chainedPbkdf2(secret, SALT, 1000))).toBe(toHex(expected));
  });

  it("chains segments, each keyed with the passphrase and salted with the previous output", async () => {
    const secret = new TextEncoder().encode(PASSPHRASE);
    const first = await pbkdf2(secret, new Uint8Array([...SALT, 0, 0, 0, 1]), 2);
    const second = await pbkdf2(secret, new Uint8Array([...SALT, 0, 0, 0, 2, ...first]), 1);
    expect(toHex(await chainedPbkdf2(secret, SALT, 3, 2))).toBe(toHex(second));
  });
});

describe("X25519", () => {
  // RFC 7748 section 6.1.
  const alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bob = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");

  it("derives the public key of a raw private key (RFC 7748 vectors)", async () => {
    expect(toHex((await x25519FromPrivate(alice)).publicKey)).toBe(
      "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    );
    expect(toHex((await x25519FromPrivate(bob)).publicKey)).toBe(
      "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    );
  });

  it("agrees on the RFC 7748 shared secret", async () => {
    const a = await x25519FromPrivate(alice);
    const b = await x25519FromPrivate(bob);
    const bobPublic = await crypto.subtle.importKey(
      "raw",
      b.publicKey,
      { name: "X25519" },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: "X25519", public: bobPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      a.privateKey,
      256,
    );
    expect(toHex(new Uint8Array(shared))).toBe(
      "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
    );
  });
});

describe("passphrase key material", () => {
  // Node's own crypto module (pbkdf2Sync, hkdfSync, and an X25519 key from PKCS #8 DER)
  // gives the same two values, so the vector does not only check this code against itself.
  it("derives a fixed public key and verifier from a fixed passphrase and salts", async () => {
    const material = await createKeyMaterial(PASSPHRASE, {
      iterations: 1000,
      verifierIterations: 10,
      salt: SALT,
      verifierSalt: VERIFIER_SALT,
    });
    expect(material).toEqual({
      publicKey: "ehsNbBxqx3QSWN5-dCkWEt_s3e21QX_z6fzwcQkdPjA",
      kdfSalt: "AQEBAQEBAQEBAQEBAQEBAQ",
      kdfIterations: 1000,
      verifier: "TO6_r4re-A7LaJy5goepMcMbYWEOdA3_yrhJKashYVQ",
      verifierSalt: "AgICAgICAgICAgICAgICAg",
      verifierIterations: 10,
    });
  });

  it("uses random salts and at least 600,000 iterations by default", async () => {
    const started = performance.now();
    const material = await createKeyMaterial(PASSPHRASE);
    const elapsed = performance.now() - started;
    expect(material.kdfIterations).toBe(BACKUP_KDF_ITERATIONS);
    expect(BACKUP_KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(material.kdfSalt).not.toBe(material.verifierSalt);
    expect(fromBase64Url(material.kdfSalt)).toHaveLength(16);
    // About 40 ms in local workerd on an Apple M-series CPU. The bound only catches a hang.
    expect(elapsed).toBeLessThan(10_000);
    await expect(derivePrivateKey(PASSPHRASE, material)).resolves.toBeDefined();
  });

  it("rejects a passphrase under 12 characters", async () => {
    const error = await rejection(createKeyMaterial("short-pass1", { iterations: 10 }));
    expect(error).toBeInstanceOf(BackupCryptoError);
    expect((error as Error).message).toContain("12 characters");
  });

  it("rejects a wrong passphrase with the verifier", async () => {
    const material = await createKeyMaterial(PASSPHRASE, { iterations: 1000 });
    expect(
      await rejection(derivePrivateKey("correct horse battery stapler", material)),
    ).toBeInstanceOf(WrongPassphraseError);
  });
});

describe("chunks", () => {
  it("round-trips, and binds the backup id and the chunk index", async () => {
    const key = generateDataKey();
    const plain = new TextEncoder().encode('{"id":1}\n');
    const sealed = await encryptChunk(key, "backup-a", 3, plain);
    expect(sealed.length).toBe(12 + plain.length + 16);
    expect(new TextDecoder().decode(await decryptChunk(key, "backup-a", 3, sealed))).toBe(
      '{"id":1}\n',
    );
    // A swapped chunk (another index) and a chunk of another backup do not decrypt.
    expect(await rejection(decryptChunk(key, "backup-a", 4, sealed))).toBeInstanceOf(
      BackupCryptoError,
    );
    expect(await rejection(decryptChunk(key, "backup-b", 3, sealed))).toBeInstanceOf(
      BackupCryptoError,
    );
    expect(await rejection(decryptChunk(generateDataKey(), "backup-a", 3, sealed))).toBeInstanceOf(
      BackupCryptoError,
    );
  });

  it("uses a unique IV for each chunk", async () => {
    const key = generateDataKey();
    const plain = new TextEncoder().encode("same");
    const a = await encryptChunk(key, "b", 0, plain);
    const b = await encryptChunk(key, "b", 0, plain);
    expect(toHex(a.subarray(0, 12))).not.toBe(toHex(b.subarray(0, 12)));
  });
});

describe("wrapping to the public key", () => {
  it("wraps without the passphrase and unwraps only with it", async () => {
    const material = await createKeyMaterial(PASSPHRASE, { iterations: 1000 });
    const dataKey = generateDataKey();
    const wrapped = await wrapForRecipient(material.publicKey, "backup-1", {
      dataKey,
      secrets: SECRETS,
    });
    expect(JSON.stringify(wrapped)).not.toContain(SECRETS.signingKey);

    const opened = await unwrap(wrapped, "backup-1", PASSPHRASE, material);
    expect(toBase64Url(opened.dataKey)).toBe(toBase64Url(dataKey));
    expect(opened.secrets).toEqual(SECRETS);

    expect(
      await rejection(unwrap(wrapped, "backup-1", "not the passphrase!", material)),
    ).toBeInstanceOf(WrongPassphraseError);
    // A wrapped key moved to another backup does not open.
    expect(await rejection(unwrap(wrapped, "backup-2", PASSPHRASE, material))).toBeInstanceOf(
      BackupCryptoError,
    );
  });
});

describe("data key in the Workflow state", () => {
  it("seals with ENCRYPTION_KEY and the backup id", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
    const dataKey = generateDataKey();
    const sealed = await sealDataKey(key, "backup-1", dataKey);
    expect(sealed).not.toContain(toBase64Url(dataKey));
    expect(toBase64Url(await openDataKey(key, "backup-1", sealed))).toBe(toBase64Url(dataKey));
    expect(await rejection(openDataKey(key, "backup-2", sealed))).toBeInstanceOf(BackupCryptoError);
  });
});
