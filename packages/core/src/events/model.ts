import type { ProviderEventType } from "@envelopen/db";

// Events on their way to D1 (KTD31). Tracking hits and verified provider events go to
// the EventBuffer Durable Object of their workspace as these small JSON values. The
// buffer stores them and flushes them in groups (flush.ts).

export type TrackingEventType = "open" | "click" | "unsubscribe";

/** A pixel load, a click, or an unsubscribe, already verified and classified. */
export interface TrackingEvent {
  source: "tracking";
  type: TrackingEventType;
  campaignId: number;
  /** `campaign_recipients.id`, from the signed token. */
  recipientId: number;
  contactId: number | null;
  /** `links.id` of a click. Null for a honeypot hit. */
  linkId: number | null;
  /** An open that a machine made, for example Apple Mail Privacy Protection (KTD29). */
  machine: boolean;
  /** A click that a scanner made (KTD29). */
  bot: boolean;
  /** Why the classifier flagged the event, for example `asn` or `honeypot`. */
  reason: string | null;
  occurredAt: number;
}

/** A row of `provider_events` that the webhook stored and the pipeline has not applied. */
export interface ProviderEventRef {
  source: "provider";
  /** `provider_events.id`. */
  id: number;
  type: ProviderEventType;
  providerMessageId: string | null;
  emailHash: string | null;
  occurredAt: number;
}

export type BufferedEvent = TrackingEvent | ProviderEventRef;

/** The flush writes at most this many events at once (KTD31). */
export const FLUSH_SIZE = 200;
/** A partly full buffer flushes this long after its first event (KTD31). */
export const FLUSH_DELAY_MS = 30_000;
/** Three soft bounces in this window suppress the address (R44). */
export const SOFT_BOUNCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SOFT_BOUNCE_LIMIT = 3;

/** A buffered event is JSON. This checks one that comes back from storage or an RPC call. */
export function isBufferedEvent(value: unknown): value is BufferedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (!Number.isFinite(event.occurredAt)) return false;
  if (event.source === "tracking") {
    return (
      (event.type === "open" || event.type === "click" || event.type === "unsubscribe") &&
      Number.isSafeInteger(event.campaignId) &&
      Number.isSafeInteger(event.recipientId)
    );
  }
  return event.source === "provider" && Number.isSafeInteger(event.id);
}

/** The key that makes a second copy of one provider event a no-op in the buffer. */
export function bufferKey(event: BufferedEvent): string | null {
  return event.source === "provider" ? `provider:${event.id}` : null;
}
