import type { DailyCounter } from "@envelopen/core";

// The client of the rolling daily counter in the RateLimiter Durable Object
// (do/rate-limiter.ts, U19). It lives apart from the class, so modules that Node.js also
// loads (the OpenAPI script) do not import `cloudflare:workers`.

/** The rolling daily counters of capped connections, one RateLimiter object each. */
export function dailyCounter(env: Pick<Env, "RATE_LIMITER">): DailyCounter {
  const stub = (connectionId: number) => env.RATE_LIMITER.getByName(`connection:${connectionId}`);
  return {
    used: (connectionId) => stub(connectionId).dailyUsage(),
    reserve: (connectionId, units, cap) => stub(connectionId).reserveDaily(units, cap),
    release: (connectionId, units, at) => stub(connectionId).releaseDaily(units, at),
  };
}
