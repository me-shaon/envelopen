import { DurableObject } from "cloudflare:workers";

// A token bucket per provider connection (KTD25, R37). The unit is what the adapter
// declares: recipients (SES, Cloudflare Email) or requests (Resend, Postmark, toSend).
// The rate comes from the provider facts, or from the account's own limit when the
// connection knows it (the SES MaxSendRate).
//
// A Durable Object runs one call at a time, so consumers in any isolate share one
// bucket. `acquire` reserves tokens and returns how long to wait: the bucket can go
// below zero, so each later caller waits behind the earlier ones and the average rate
// holds. A reservation that would wait longer than the caller allows is not taken, and
// the caller retries the message later. A 429 with `Retry-After` stops the bucket
// until that time.

export interface RateRule {
  /** Tokens per second. */
  ratePerSecond: number;
  /** The most tokens the bucket holds: one second of the rate, at least 1. */
  burst: number;
}

export type Grant = { granted: true; waitMs: number } | { granted: false; retryAfterMs: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
}

export function rateRule(ratePerSecond: number): RateRule {
  const rate = Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? ratePerSecond : 1;
  return { ratePerSecond: rate, burst: Math.max(1, rate) };
}

/** The bucket math, without storage, so tests can check it directly. */
export function reserve(
  bucket: Bucket | undefined,
  units: number,
  rule: RateRule,
  maxWaitMs: number,
  now: number,
): { bucket: Bucket; grant: Grant } {
  const start = bucket ?? { tokens: rule.burst, updatedAt: now, blockedUntil: 0 };
  const elapsed = Math.max(0, now - start.updatedAt);
  const tokens = Math.min(rule.burst, start.tokens + (elapsed / 1000) * rule.ratePerSecond);
  const blockedFor = Math.max(0, start.blockedUntil - now);
  const after = tokens - units;
  const waitMs = Math.max(
    blockedFor,
    after >= 0 ? 0 : Math.ceil((-after / rule.ratePerSecond) * 1000),
  );
  const refilled = { tokens, updatedAt: now, blockedUntil: start.blockedUntil };
  if (waitMs > maxWaitMs)
    return { bucket: refilled, grant: { granted: false, retryAfterMs: waitMs } };
  return { bucket: { ...refilled, tokens: after }, grant: { granted: true, waitMs } };
}

export class RateLimiter extends DurableObject<Env> {
  async acquire(
    units: number,
    rule: RateRule,
    maxWaitMs: number,
    now = Date.now(),
  ): Promise<Grant> {
    const stored = await this.ctx.storage.get<Bucket>("bucket");
    const { bucket, grant } = reserve(stored, units, rule, maxWaitMs, now);
    await this.ctx.storage.put("bucket", bucket);
    return grant;
  }

  /** The provider answered 429: no tokens until `retryAfterMs` has passed. */
  async backoff(retryAfterMs: number, now = Date.now()): Promise<void> {
    const stored = await this.ctx.storage.get<Bucket>("bucket");
    const bucket = stored ?? { tokens: 0, updatedAt: now, blockedUntil: 0 };
    await this.ctx.storage.put("bucket", {
      tokens: Math.min(bucket.tokens, 0),
      updatedAt: now,
      blockedUntil: Math.max(bucket.blockedUntil, now + Math.max(0, retryAfterMs)),
    });
  }
}

export function rateLimiterFor(env: Pick<Env, "RATE_LIMITER">, connectionId: number) {
  return env.RATE_LIMITER.getByName(`connection:${connectionId}`);
}
