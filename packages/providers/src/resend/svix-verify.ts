import { base64ToBytes, bytesToBase64, hmacSha256, timingSafeEqual } from "../shared/encoding";
import type { WebhookVerification } from "../types";

// Svix webhook signatures, as Resend sends them.
// https://docs.svix.com/receiving/verifying-payloads/how-manual
//
// The signed content is `${svix-id}.${svix-timestamp}.${body}`, signed with HMAC-SHA256
// under the base64 key after the `whsec_` prefix. The header holds one or more
// space-separated `v1,<base64>` signatures (several during a secret rotation).

/** The Svix libraries accept timestamps within 5 minutes, in both directions. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function svixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get("svix-id") ?? headers.get("webhook-id"),
    timestamp: headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
    signature: headers.get("svix-signature") ?? headers.get("webhook-signature"),
  };
}

/** The base64 signature of a payload. Senders and tests use it. */
export async function svixSign(
  secret: string,
  id: string,
  timestamp: number | string,
  body: string,
): Promise<string> {
  const key = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!key) throw new Error("The webhook secret is not base64.");
  return bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`));
}

export async function verifySvix(
  secret: string,
  headers: SvixHeaders,
  body: string,
  nowMs: number,
): Promise<WebhookVerification> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "Missing Svix headers." };
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds)) {
    return { ok: false, reason: "The timestamp is not valid." };
  }
  // A replayed request carries its old timestamp, and the signature covers it.
  if (Math.abs(nowMs / 1000 - seconds) > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: "The timestamp is outside the 5 minute window." };
  }
  let expected: string;
  try {
    expected = await svixSign(secret, id, timestamp, body);
  } catch {
    return { ok: false, reason: "The webhook secret is not valid." };
  }
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version === "v1" && value && timingSafeEqual(value, expected)) return { ok: true };
  }
  return { ok: false, reason: "The signature does not match." };
}
