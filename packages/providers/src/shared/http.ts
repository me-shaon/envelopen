import type {
  AdapterContext,
  BatchFailure,
  FailureReason,
  OutgoingMessage,
  RecipientResult,
  SendBatchResult,
} from "../types";

// HTTP helpers that every adapter shares: a fetch with a timeout, and the failure
// classes of KTD12. A refused request (`not_sent`) is safe to retry. A timeout, a
// network error, or a 5xx (`unknown`) may have sent the email.

export const DEFAULT_TIMEOUT_MS = 15_000;

export type HttpCall =
  | { ok: true; response: Response }
  | { ok: false; reason: "timeout" | "network"; message: string };

/** Calls the provider. A timeout or a network error is a value, not an exception. */
export async function callProvider(
  ctx: AdapterContext,
  input: string | Request,
  init: RequestInit = {},
): Promise<HttpCall> {
  try {
    const response = await ctx.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { ok: true, response };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, reason: "timeout", message: "The provider did not answer in time." };
    }
    return { ok: false, reason: "network", message: "The provider could not be reached." };
  }
}

/** Reads a JSON body. Returns null for an empty or invalid body. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `Retry-After` in milliseconds, from seconds or an HTTP date. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The default class of an HTTP status. Adapters refine it with the provider's error code. */
export function classifyStatus(status: number): {
  outcome: BatchFailure["outcome"];
  reason: FailureReason;
} {
  if (status === 429) return { outcome: "not_sent", reason: "rate_limited" };
  if (status === 401 || status === 403) return { outcome: "not_sent", reason: "auth" };
  if (status === 402) return { outcome: "not_sent", reason: "credits" };
  if (status >= 500) return { outcome: "unknown", reason: "server_error" };
  return { outcome: "not_sent", reason: "validation" };
}

/** A batch result where every recipient has the outcome of one failed request. */
export function failBatch(
  messages: readonly OutgoingMessage[],
  failure: BatchFailure,
): SendBatchResult {
  return {
    failure,
    results: messages.map((message) => ({
      recipientId: message.recipientId,
      outcome: failure.outcome,
      reason: failure.reason,
      message: failure.message,
    })),
  };
}

/** The batch failure of a timeout or a network error. */
export function transportFailure(call: Extract<HttpCall, { ok: false }>): BatchFailure {
  return { outcome: "unknown", reason: call.reason, message: call.message };
}

/** True when every result is `sent`. */
export function allSent(results: readonly RecipientResult[]): boolean {
  return results.every((result) => result.outcome === "sent");
}

/** A short, safe error text from a provider body: no more than 300 characters. */
export function shortMessage(text: unknown, fallback: string): string {
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 300) : fallback;
}
