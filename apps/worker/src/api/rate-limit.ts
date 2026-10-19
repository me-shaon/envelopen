import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./context";
import { errorJson } from "./errors";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix milliseconds when the window resets. */
  resetAt: number;
}

/**
 * Counts requests per key (R58). The fixed-window counter below is the v1
 * implementation. A Durable Object counter (as for login in KTD8) or the Workers rate
 * limiting binding can implement this interface later without a change to the router.
 */
export interface RateLimiter {
  hit(key: string, now?: number): Promise<RateLimitResult>;
}

export interface FixedWindowOptions {
  limit: number;
  windowMs: number;
  /** Bound on tracked keys, so memory stays small. */
  maxKeys?: number;
}

/**
 * Fixed-window counter in isolate memory. Each Worker isolate counts on its own, so
 * the effective limit is per isolate. It is a guard against runaway clients, not an
 * exact quota, and it costs no storage writes on the Free plan.
 */
export function createFixedWindowLimiter(options: FixedWindowOptions): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const windows = new Map<string, { start: number; count: number }>();

  function prune(now: number) {
    for (const [key, window] of windows) {
      if (now - window.start >= windowMs) windows.delete(key);
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    async hit(key, now = Date.now()) {
      let window = windows.get(key);
      if (!window || now - window.start >= windowMs) {
        if (!window && windows.size >= maxKeys) prune(now);
        window = { start: now - (now % windowMs), count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      return {
        allowed: window.count <= limit,
        limit,
        remaining: Math.max(0, limit - window.count),
        resetAt: window.start + windowMs,
      };
    },
  };
}

/** Default: 120 requests per minute per API key. */
export const DEFAULT_API_KEY_RATE_LIMIT: FixedWindowOptions = { limit: 120, windowMs: 60_000 };

/**
 * Applies the limiter to API-key principals. Sessions are not limited here: login and
 * setup get their own limiter in U4 (KTD8). Run it after the principal middleware.
 */
export function apiKeyRateLimit(limiter: RateLimiter): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const { apiKeyId } = c.var.principal;
    if (apiKeyId === null) return next();

    const now = Date.now();
    const result = await limiter.hit(`api_key:${apiKeyId}`, now);
    const resetSeconds = Math.max(0, Math.ceil((result.resetAt - now) / 1000));
    c.header("RateLimit-Limit", String(result.limit));
    c.header("RateLimit-Remaining", String(result.remaining));
    c.header("RateLimit-Reset", String(resetSeconds));
    if (!result.allowed) {
      c.header("Retry-After", String(resetSeconds));
      return errorJson(
        c,
        429,
        "rate_limited",
        "This API key sent too many requests. Try again later.",
      );
    }
    await next();
  };
}
