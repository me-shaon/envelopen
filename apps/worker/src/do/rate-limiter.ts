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
//
// The same object keeps the rolling daily counter of a connection with a `daily_cap`
// (U19, KTD14): the messages of the last 24 hours, in 5-minute buckets. Campaign
// batches, welcome steps, and confirmation emails reserve from it before they send. A
// bucket counts while any part of it is less than 24 hours old, so the counter never
// counts low, and no 24-hour period sends more than the cap. A reservation that the cap
// does not allow returns the first time at which it fits. A send that the provider
// refused gives its reservation back.

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

// The rolling daily counter ----------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The size of one bucket of the daily counter. */
export const DAILY_BUCKET_MS = 5 * 60 * 1000;

/** Messages by bucket number (`floor(time / DAILY_BUCKET_MS)`). */
export type DailyBuckets = Record<string, number>;

/**
 * The answer of a daily reservation. `at` names the bucket, for a later release.
 * `freeAt` is null when the request is larger than the whole cap.
 */
export type DailyGrant = { granted: true; at: number } | { granted: false; freeAt: number | null };

/** True while the bucket counts: some part of it is less than 24 hours old. */
function counts(bucket: number, now: number): boolean {
  return (bucket + 1) * DAILY_BUCKET_MS + DAY_MS > now;
}

/** The buckets that still count. */
export function pruneDaily(buckets: DailyBuckets | undefined, now: number): DailyBuckets {
  const kept: DailyBuckets = {};
  for (const [key, count] of Object.entries(buckets ?? {})) {
    if (count > 0 && counts(Number(key), now)) kept[key] = count;
  }
  return kept;
}

/** The messages of the last 24 hours. */
export function dailyUsed(buckets: DailyBuckets | undefined, now: number): number {
  let used = 0;
  for (const count of Object.values(pruneDaily(buckets, now))) used += count;
  return used;
}

/** The first time at which `units` more messages fit in the cap, or null if never. */
export function dailyFreeAt(
  buckets: DailyBuckets | undefined,
  units: number,
  cap: number,
  now: number,
): number | null {
  if (units > cap) return null;
  const kept = pruneDaily(buckets, now);
  let used = dailyUsed(kept, now);
  if (used + units <= cap) return now;
  for (const key of Object.keys(kept)
    .map(Number)
    .sort((a, b) => a - b)) {
    used -= kept[String(key)] ?? 0;
    if (used + units <= cap) return (key + 1) * DAILY_BUCKET_MS + DAY_MS;
  }
  return now;
}

/** The daily reservation math, without storage, so tests can check it directly. */
export function reserveDaily(
  buckets: DailyBuckets | undefined,
  units: number,
  cap: number,
  now: number,
): { buckets: DailyBuckets; grant: DailyGrant } {
  const kept = pruneDaily(buckets, now);
  const freeAt = dailyFreeAt(kept, units, cap, now);
  if (freeAt !== now) return { buckets: kept, grant: { granted: false, freeAt } };
  const key = String(Math.floor(now / DAILY_BUCKET_MS));
  kept[key] = (kept[key] ?? 0) + units;
  return { buckets: kept, grant: { granted: true, at: now } };
}

/** Gives back `units` of a reservation made at `at`. */
export function releaseDaily(
  buckets: DailyBuckets | undefined,
  units: number,
  at: number,
  now: number,
): DailyBuckets {
  const kept = pruneDaily(buckets, now);
  const key = String(Math.floor(at / DAILY_BUCKET_MS));
  const left = (kept[key] ?? 0) - Math.max(0, units);
  if (left > 0) kept[key] = left;
  else delete kept[key];
  return kept;
}

/** A daily reservation that the token bucket call makes in the same turn. */
export interface DailyRequest {
  units: number;
  cap: number;
}

/** The token bucket answer, and the daily answer when the call asked for one. */
export type CombinedGrant =
  | (Extract<Grant, { granted: true }> & { daily?: Extract<DailyGrant, { granted: true }> })
  | Extract<Grant, { granted: false }>
  | { granted: false; daily: Extract<DailyGrant, { granted: false }> };

export class RateLimiter extends DurableObject<Env> {
  /**
   * Reserves rate tokens. With `daily`, it also reserves from the daily counter: the
   * daily check comes first, and a refusal of either takes nothing from the other.
   */
  async acquire(
    units: number,
    rule: RateRule,
    maxWaitMs: number,
    now = Date.now(),
    daily?: DailyRequest,
  ): Promise<CombinedGrant> {
    let counted: DailyBuckets | undefined;
    if (daily) {
      const stored = await this.ctx.storage.get<DailyBuckets>("daily");
      const freeAt = dailyFreeAt(stored, daily.units, daily.cap, now);
      if (freeAt !== now) return { granted: false, daily: { granted: false, freeAt } };
      counted = stored;
    }
    const stored = await this.ctx.storage.get<Bucket>("bucket");
    const { bucket, grant } = reserve(stored, units, rule, maxWaitMs, now);
    await this.ctx.storage.put("bucket", bucket);
    if (!grant.granted || !daily) return grant;
    const reserved = reserveDaily(counted, daily.units, daily.cap, now);
    await this.ctx.storage.put("daily", reserved.buckets);
    return { ...grant, daily: { granted: true, at: now } };
  }

  /** Reserves `units` messages from the daily counter. */
  async reserveDaily(units: number, cap: number, now = Date.now()): Promise<DailyGrant> {
    const stored = await this.ctx.storage.get<DailyBuckets>("daily");
    const { buckets, grant } = reserveDaily(stored, units, cap, now);
    if (grant.granted) await this.ctx.storage.put("daily", buckets);
    return grant;
  }

  /** Gives back a daily reservation of `units` made at `at`: the provider sent nothing. */
  async releaseDaily(units: number, at: number, now = Date.now()): Promise<void> {
    const stored = await this.ctx.storage.get<DailyBuckets>("daily");
    await this.ctx.storage.put("daily", releaseDaily(stored, units, at, now));
  }

  /**
   * The provider said that its daily quota is spent: the counter counts the cap as used
   * from now, so other sends wait until the provider's quota has room again.
   */
  async fillDaily(cap: number, now = Date.now()): Promise<void> {
    const stored = pruneDaily(await this.ctx.storage.get<DailyBuckets>("daily"), now);
    const missing = cap - dailyUsed(stored, now);
    if (missing <= 0) return;
    const key = String(Math.floor(now / DAILY_BUCKET_MS));
    stored[key] = (stored[key] ?? 0) + missing;
    await this.ctx.storage.put("daily", stored);
  }

  /** The messages of the last 24 hours. */
  async dailyUsage(now = Date.now()): Promise<number> {
    return dailyUsed(await this.ctx.storage.get<DailyBuckets>("daily"), now);
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
