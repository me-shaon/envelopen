import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DAILY_BUCKET_MS,
  DAY_MS,
  dailyFreeAt,
  dailyUsed,
  rateLimiterFor,
  rateRule,
  releaseDaily,
  reserveDaily,
} from "./rate-limiter";

// The rolling daily counter of a capped connection (U19, KTD14): the math, then the
// Durable Object with an explicit clock.

const T0 = Date.UTC(2026, 9, 19, 12);
const HOUR = 60 * 60 * 1000;

describe("daily counter math", () => {
  it("grants up to the cap, then names the time when the oldest sends age out", () => {
    let buckets = reserveDaily(undefined, 300, 500, T0).buckets;
    buckets = reserveDaily(buckets, 200, 500, T0 + HOUR).buckets;
    expect(dailyUsed(buckets, T0 + 2 * HOUR)).toBe(500);
    const refused = reserveDaily(buckets, 50, 500, T0 + 2 * HOUR);
    // The 300 of T0 free at the end of their bucket plus 24 hours.
    expect(refused.grant).toEqual({ granted: false, freeAt: T0 + DAILY_BUCKET_MS + DAY_MS });
    expect(dailyUsed(buckets, T0 + DAILY_BUCKET_MS + DAY_MS)).toBe(200);
    expect(reserveDaily(buckets, 300, 500, T0 + DAILY_BUCKET_MS + DAY_MS).grant.granted).toBe(true);
  });

  it("never lets a 24-hour period hold more than the cap", () => {
    let buckets = {};
    const sends: number[] = [];
    // A request of 7 every 7 minutes for 3 days, under a cap of 100.
    for (let at = T0; at < T0 + 3 * DAY_MS; at += 7 * 60 * 1000) {
      const result = reserveDaily(buckets, 7, 100, at);
      buckets = result.buckets;
      if (result.grant.granted) sends.push(at);
    }
    for (const start of sends) {
      const inDay = sends.filter((at) => at >= start && at < start + DAY_MS).length * 7;
      expect(inDay).toBeLessThanOrEqual(100);
    }
    expect(sends.length).toBeGreaterThan(30);
  });

  it("refuses a request larger than the cap for good, and releases a reservation", () => {
    expect(dailyFreeAt(undefined, 600, 500, T0)).toBeNull();
    const reserved = reserveDaily(undefined, 50, 500, T0);
    expect(dailyUsed(releaseDaily(reserved.buckets, 50, T0, T0 + 1), T0 + 1)).toBe(0);
  });
});

describe("RateLimiter daily counter", () => {
  it("reserves with the rate tokens in one call, and fills at a provider quota", async () => {
    const stub = rateLimiterFor(env, 900_001);
    const rule = rateRule(100);
    const first = await stub.acquire(50, rule, 30_000, T0, { units: 50, cap: 80 });
    expect(first).toMatchObject({ granted: true, daily: { granted: true, at: T0 } });
    // No room for 50 more: no rate tokens are taken either.
    const second = await stub.acquire(50, rule, 30_000, T0 + 1000, { units: 50, cap: 80 });
    expect(second).toEqual({
      granted: false,
      daily: { granted: false, freeAt: T0 + DAILY_BUCKET_MS + DAY_MS },
    });
    expect(await stub.dailyUsage(T0 + 1000)).toBe(50);
    await stub.releaseDaily(20, T0, T0 + 2000);
    expect(await stub.dailyUsage(T0 + 2000)).toBe(30);
    await stub.fillDaily(80, T0 + 3000);
    expect(await stub.dailyUsage(T0 + 3000)).toBe(80);
    expect(await stub.reserveDaily(1, 80, T0 + 4000)).toMatchObject({ granted: false });
    expect(await stub.reserveDaily(1, 80, T0 + DAY_MS + DAILY_BUCKET_MS)).toEqual({
      granted: true,
      at: T0 + DAY_MS + DAILY_BUCKET_MS,
    });
  });
});
