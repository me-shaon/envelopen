import { timingSafeEqual } from "../shared/encoding";
import type {
  NormalizedEvent,
  ParsedWebhook,
  ProviderEventType,
  ProviderRefs,
  ProviderUnsubscribe,
  WebhookRequest,
  WebhookTarget,
  WebhookVerification,
} from "../types";

// Brevo transactional webhooks for the Brevo preset of the SMTP adapter (KTD13, R25).
//
// Brevo signs nothing, so the receiver authenticates each request with a bearer token:
// - Envelopen generates the token at connect. It is stored encrypted and bound to the
//   connection id, like every webhook secret (packages/core/src/connections/model.ts).
// - Brevo sends it in the Authorization header (`auth.type: bearer` of the webhook).
//   The URL never holds it: the path carries only the workspace and connection ids, and
//   a request with a query string is refused.
// - The compare runs in constant time, also when the header is missing.
// - The owner can rotate the token from the connection page.
//
// Event mapping (https://developers.brevo.com/docs/transactional-webhooks, checked
// 2026-10-22):
//   hard_bounce, invalid_email -> bounce_hard (the address is suppressed)
//   soft_bounce                -> bounce_soft
//   spam                       -> complaint (the address is suppressed)
//   blocked                    -> failed (Brevo did not send: its own block list)
//   unsubscribed               -> an unsubscribe of the contact
// Every other event, for example opens and clicks, is skipped: Envelopen tracks them.

/** The Brevo API event names of the webhook that the manual steps create. */
export const BREVO_WEBHOOK_EVENTS = [
  "hardBounce",
  "softBounce",
  "invalid",
  "blocked",
  "spam",
  "unsubscribed",
] as const;

const EVENT_TYPES: Readonly<Record<string, ProviderEventType>> = {
  hard_bounce: "bounce_hard",
  invalid_email: "bounce_hard",
  soft_bounce: "bounce_soft",
  spam: "complaint",
  blocked: "failed",
};

/** Events in one request. Brevo sends one event per request unless batching is on. */
const MAX_EVENTS = 100;

/** The bearer token of an Authorization header, or an empty string. */
export function bearerToken(headers: Headers): string {
  const value = headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(value);
  return match?.[1] ?? "";
}

/** Compares the request's bearer token with the connection's token in constant time. */
export function bearerMatches(headers: Headers, secret: string): boolean {
  const token = bearerToken(headers);
  // The compare runs for an empty token too, so a missing header takes the same path.
  const equal = timingSafeEqual(token, secret);
  return equal && token.length > 0 && secret.length > 0;
}

export function verifyBrevoWebhook(
  request: WebhookRequest,
  secret: string,
  refs: ProviderRefs,
): WebhookVerification {
  if (refs.preset !== "brevo") {
    return { ok: false, reason: "This SMTP connection receives no webhooks." };
  }
  if (request.method !== "POST") return { ok: false, reason: "Brevo webhooks are POST requests." };
  let search = "";
  try {
    search = new URL(request.url).search;
  } catch {
    return { ok: false, reason: "The webhook URL is not valid." };
  }
  const matches = bearerMatches(request.headers, secret);
  if (search) return { ok: false, reason: "Envelopen does not accept a token in the URL." };
  if (!matches) return { ok: false, reason: "The bearer token does not match." };
  return { ok: true };
}

type BrevoEvent = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function occurredAt(event: BrevoEvent): number {
  if (typeof event.ts_epoch === "number" && Number.isFinite(event.ts_epoch)) return event.ts_epoch;
  for (const key of ["ts_event", "ts"]) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  }
  return Date.now();
}

/**
 * Brevo sends no event id, so the id is built from the event's own fields. A replay of
 * the same delivery gives the same id, and the store keeps it once.
 */
function eventIdOf(event: BrevoEvent, name: string, email: string, at: number): string {
  const message = text(event["message-id"]) ?? "";
  return `brevo:${name}:${message}:${email.toLowerCase()}:${at}`;
}

export function parseBrevoEvents(request: WebhookRequest): ParsedWebhook {
  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return { events: [], unsubscribes: [] };
  }
  const list = (Array.isArray(body) ? body : [body]).slice(0, MAX_EVENTS);
  const events: NormalizedEvent[] = [];
  const unsubscribes: ProviderUnsubscribe[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const event = item as BrevoEvent;
    const name = text(event.event);
    const email = text(event.email);
    if (!name || !email) continue;
    const at = occurredAt(event);
    const eventId = eventIdOf(event, name, email, at);
    const providerMessageId = text(event["message-id"]);
    if (name === "unsubscribed") {
      unsubscribes.push({ eventId, email, providerMessageId, occurredAt: at });
      continue;
    }
    const type = EVENT_TYPES[name];
    if (!type) continue;
    const reason = text(event.reason);
    events.push({
      type,
      eventId,
      providerMessageId,
      email,
      occurredAt: at,
      detail: reason ? `${name}: ${reason}`.slice(0, 200) : name,
    });
  }
  return { events, unsubscribes };
}

/** The steps that create the Brevo webhook. Brevo sets bearer auth through its API. */
export function brevoWebhookSteps(target: WebhookTarget): string[] {
  const body = JSON.stringify({
    type: "transactional",
    url: target.url,
    events: BREVO_WEBHOOK_EVENTS,
    auth: { type: "bearer", token: target.secret },
  });
  return [
    "In Brevo, open SMTP & API, then API keys, and create an API key for this step. You can delete the key after the webhook exists.",
    `Run this command once, with your API key in place of YOUR_API_KEY: curl -X POST https://api.brevo.com/v3/webhooks -H "api-key: YOUR_API_KEY" -H "content-type: application/json" -d '${body}'`,
    `Brevo then sends hard bounces, soft bounces, invalid addresses, blocked messages, spam complaints, and unsubscribes to ${target.url}, with the token in the Authorization header.`,
    "If you rotate the token, update the webhook in Brevo with the new token (PUT /v3/webhooks/{id} with the same auth object), or delete it and run the command again.",
  ];
}
