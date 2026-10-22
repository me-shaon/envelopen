import { bytesToHex, hmacSha256, timingSafeEqual, utf8 } from "../shared/encoding";
import type {
  NormalizedEvent,
  ParsedWebhook,
  ProviderEventType,
  ProviderUnsubscribe,
  WebhookRequest,
  WebhookVerification,
} from "../types";

// Mailgun webhooks (KTD15).
// https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
//
// Mailgun posts one event per request as JSON: `{ "signature": {...}, "event-data": {...} }`.
// The signature is HMAC-SHA256 of `timestamp + token`, with the account's HTTP webhook
// signing key, as hex. It does not cover `event-data`. So:
// - The timestamp must be within 5 minutes of the clock.
// - Each token is good for one request. `verifyMailgunWebhook` returns the token as a
//   nonce, and the hook route records it in D1 (`webhook_nonces`). A second request with
//   the same token is rejected, also when its body differs. KV is eventually
//   consistent, so it cannot do this check.
// - The event id of `event-data` is the unique key of `provider_events`, so a replayed
//   event is stored once.

/** How far the timestamp can be from the clock, in each direction. */
export const MAILGUN_WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

/** The event types that Envelopen asks Mailgun to send. */
export const MAILGUN_WEBHOOK_EVENTS = [
  "delivered",
  "permanent_fail",
  "temporary_fail",
  "complained",
  "unsubscribed",
] as const;

interface MailgunSignature {
  timestamp?: unknown;
  token?: unknown;
  signature?: unknown;
}

interface MailgunEventData {
  id?: string;
  event?: string;
  timestamp?: number;
  severity?: string;
  reason?: string;
  recipient?: string;
  message?: { headers?: Record<string, string | undefined> };
  "delivery-status"?: { code?: number; message?: string; description?: string };
}

interface MailgunWebhookBody {
  signature?: MailgunSignature;
  "event-data"?: MailgunEventData;
}

function parseBody(body: string): MailgunWebhookBody | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" ? (value as MailgunWebhookBody) : null;
  } catch {
    return null;
  }
}

/** The hex signature of `timestamp + token`, as Mailgun computes it. */
export async function mailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
): Promise<string> {
  return bytesToHex(await hmacSha256(utf8(signingKey), `${timestamp}${token}`));
}

/** Checks the signature and the timestamp. The caller rejects a reused token (the nonce). */
export async function verifyMailgunWebhook(
  request: WebhookRequest,
  signingKey: string,
  now: number,
): Promise<WebhookVerification> {
  if (!signingKey) return { ok: false, reason: "No signing key." };
  const signature = parseBody(request.body)?.signature;
  const timestamp = signature?.timestamp;
  const token = signature?.token;
  const value = signature?.signature;
  if (
    (typeof timestamp !== "string" && typeof timestamp !== "number") ||
    typeof token !== "string" ||
    typeof value !== "string"
  ) {
    return { ok: false, reason: "No Mailgun signature in the body." };
  }
  const stamp = String(timestamp);
  if (!/^\d{1,12}$/.test(stamp) || !/^[A-Za-z0-9]{1,200}$/.test(token)) {
    return { ok: false, reason: "The Mailgun signature has a bad timestamp or token." };
  }
  const sentAt = Number(stamp) * 1000;
  if (Math.abs(now - sentAt) > MAILGUN_WEBHOOK_WINDOW_MS) {
    return { ok: false, reason: "The timestamp is outside the 5-minute window." };
  }
  const expected = await mailgunSignature(signingKey, stamp, token);
  if (!timingSafeEqual(expected, value.trim().toLowerCase())) {
    return { ok: false, reason: "Wrong signature." };
  }
  return {
    ok: true,
    nonce: { value: token, expiresAt: sentAt + MAILGUN_WEBHOOK_WINDOW_MS },
  };
}

/**
 * The Envelopen type of a failed event. A permanent failure is a hard bounce, and a
 * temporary one is a soft bounce. Some permanent reasons are different
 * (`suppress-unsubscribe` is in `parseMailgunEvents`):
 * - `suppress-complaint`: Mailgun dropped the email because the address complained
 *   before. Envelopen keeps it as a complaint.
 * - `old`: Mailgun gave up after its retries of a temporary failure. The address may
 *   work later, so it is a soft bounce.
 */
function failedType(data: MailgunEventData): ProviderEventType {
  if (data.severity !== "permanent") return "bounce_soft";
  if (data.reason === "suppress-complaint") return "complaint";
  if (data.reason === "old") return "bounce_soft";
  return "bounce_hard";
}

/** The Message-ID without angle brackets, as the send result stores it. */
export function bareMessageId(id: string | undefined | null): string | null {
  const bare = id?.trim().replace(/^<|>$/g, "");
  return bare ? bare : null;
}

/** Normalizes a verified Mailgun webhook. Opens, clicks, and accepted events are skipped. */
export function parseMailgunEvents(request: WebhookRequest): ParsedWebhook {
  const data = parseBody(request.body)?.["event-data"];
  if (!data?.id || !data.event || !data.recipient) return { events: [] };
  const seconds = typeof data.timestamp === "number" ? data.timestamp : Number.NaN;
  const occurredAt = Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
  // Mailgun event ids are unique within a day, so the day joins the key.
  const day = Number.isFinite(seconds) ? Math.floor(seconds / 86_400) : 0;
  const eventId = `${data.event}:${data.id}:${day}`;
  const providerMessageId = bareMessageId(data.message?.headers?.["message-id"]);
  // `suppress-unsubscribe`: Mailgun dropped the email because the address unsubscribed
  // through Mailgun before. It is an unsubscribe, not a bounce.
  const droppedUnsubscribe =
    data.event === "failed" &&
    data.severity === "permanent" &&
    data.reason === "suppress-unsubscribe";
  if (data.event === "unsubscribed" || droppedUnsubscribe) {
    const unsubscribe: ProviderUnsubscribe = {
      eventId,
      email: data.recipient,
      providerMessageId,
      occurredAt,
    };
    return { events: [], unsubscribes: [unsubscribe] };
  }
  let type: ProviderEventType | null = null;
  if (data.event === "delivered") type = "delivered";
  else if (data.event === "complained") type = "complaint";
  else if (data.event === "failed") type = failedType(data);
  if (!type) return { events: [] };
  const status = data["delivery-status"];
  const detail =
    data.event === "failed"
      ? [data.severity, data.reason, status?.code].filter((part) => part !== undefined).join(" ")
      : undefined;
  const event: NormalizedEvent = {
    type,
    eventId,
    providerMessageId,
    email: data.recipient,
    occurredAt,
    ...(detail ? { detail } : {}),
  };
  return { events: [event] };
}
