import type { FileLinkRequest } from "../services";
import { deriveHmacKey } from "../suppression/hash";

// Signed download links for files in R2: import error files and exports. The link
// carries the R2 key, the file name, and the expiry, with an HMAC keyed from
// SIGNING_KEY. It works without a session, so an API client can download the file too,
// and it stops working at the expiry (24 hours for exports, R18).

const HKDF_INFO = "envelopen/file-links/v1";
export const FILE_LINK_PATH = "/api/files/";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export interface FileLinkSigner {
  /** Returns the path of the download link, for example `/api/files/<token>`. */
  sign(file: FileLinkRequest): Promise<string>;
  /** Returns the file of a valid, unexpired token, or null. */
  verify(token: string, now?: number): Promise<FileLinkRequest | null>;
}

export async function createFileLinkSigner(signingKey: string): Promise<FileLinkSigner> {
  const key = await deriveHmacKey(signingKey, HKDF_INFO);
  const encoder = new TextEncoder();
  return {
    async sign(file) {
      const payload = encoder.encode(
        JSON.stringify({ k: file.key, n: file.filename, e: file.expiresAt }),
      );
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
      return `${FILE_LINK_PATH}${toBase64Url(payload)}.${toBase64Url(signature)}`;
    },
    async verify(token, now = Date.now()) {
      const [payloadPart, signaturePart, extra] = token.split(".");
      if (!payloadPart || !signaturePart || extra !== undefined) return null;
      const payload = fromBase64Url(payloadPart);
      const signature = fromBase64Url(signaturePart);
      if (!payload || !signature) return null;
      // crypto.subtle.verify compares in constant time.
      if (!(await crypto.subtle.verify("HMAC", key, signature, payload))) return null;
      let data: { k?: unknown; n?: unknown; e?: unknown };
      try {
        data = JSON.parse(new TextDecoder().decode(payload)) as typeof data;
      } catch {
        return null;
      }
      if (typeof data.k !== "string" || typeof data.n !== "string" || typeof data.e !== "number") {
        return null;
      }
      if (data.e <= now) return null;
      return { key: data.k, filename: data.n, expiresAt: data.e };
    },
  };
}
