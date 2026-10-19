import type { EmailHasher } from "../services";

// Suppressions key on an HMAC of the normalized address, so a suppression survives a
// contact erase without the address (R19, R21). The key comes from SIGNING_KEY through
// HKDF with its own label, so it is separate from the token and session keys.
//
// The hash must stay stable: a new SIGNING_KEY changes every hash, and old suppressions
// then match nothing. Rotating SIGNING_KEY needs a rehash, which v1 does not offer.

const HKDF_INFO = "envelopen/suppression/v1";

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

/** HMAC-SHA256 of a text as lowercase hex. */
export async function hmacHex(key: CryptoKey, text: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

/** The email hasher for suppressions, keyed from SIGNING_KEY. Normalize the address first. */
export async function createEmailHasher(signingKey: string): Promise<EmailHasher> {
  const key = await deriveHmacKey(signingKey, HKDF_INFO);
  return (normalizedEmail) => hmacHex(key, normalizedEmail);
}
