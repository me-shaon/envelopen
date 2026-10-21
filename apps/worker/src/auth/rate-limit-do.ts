import { DurableObject } from "cloudflare:workers";

// Attempt counters for login, password reset, and setup (KTD8, R74). One Durable
// Object instance holds one counter, for example `login:ip:198.51.100.7` or
// `login:email:owner@example.com`. A Durable Object runs one request at a time, so
// check-and-count is exact across all Worker isolates, unlike an in-memory counter.

export interface AttemptRule {
  /** Attempts allowed in one window. The next attempt is rejected. */
  limit: number;
  windowMs: number;
}

export interface AttemptStatus {
  allowed: boolean;
  /** Attempts counted in the current window. */
  count: number;
  /** Milliseconds until the window resets, or 0 when allowed. */
  retryAfterMs: number;
}

interface Window {
  start: number;
  count: number;
}

const STORAGE_KEY = "window";

/**
 * A fixed-window counter in Durable Object storage (SQLite-backed). The counter
 * survives eviction. An alarm deletes it after the window ends, so idle keys cost
 * nothing. Methods are called through Workers RPC.
 */
export class AuthRateLimiter extends DurableObject<Env> {
  private async current(windowMs: number, now: number): Promise<Window | null> {
    const window = await this.ctx.storage.get<Window>(STORAGE_KEY);
    if (!window || now - window.start >= windowMs) return null;
    return window;
  }

  private status(window: Window | null, rule: AttemptRule, now: number): AttemptStatus {
    const count = window?.count ?? 0;
    const allowed = count < rule.limit;
    return {
      allowed,
      count,
      retryAfterMs: allowed || !window ? 0 : Math.max(0, window.start + rule.windowMs - now),
    };
  }

  /** Reports whether one more attempt is allowed, without counting it. */
  async check(rule: AttemptRule, now = Date.now()): Promise<AttemptStatus> {
    return this.status(await this.current(rule.windowMs, now), rule, now);
  }

  /** Counts one attempt (for example a failed login) and returns the new status. */
  async record(rule: AttemptRule, now = Date.now()): Promise<AttemptStatus> {
    const existing = await this.current(rule.windowMs, now);
    const window = existing
      ? { start: existing.start, count: existing.count + 1 }
      : { start: now, count: 1 };
    await this.ctx.storage.put(STORAGE_KEY, window);
    if (!existing) await this.ctx.storage.setAlarm(now + rule.windowMs);
    return this.status(window, rule, now);
  }

  /** Clears the counter, for example after a successful login for an email. */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

// Callers -------------------------------------------------------------------------------

/**
 * KTD8: after five failed logins from one IP in 15 minutes, every login from it is
 * rejected. After five failed logins for one email, a further failure for it is
 * rejected, but the right password still signs in, so failures from other IPs cannot
 * lock the owner out.
 */
export const LOGIN_RULE: AttemptRule = { limit: 5, windowMs: 15 * 60 * 1000 };
/**
 * A high ceiling of failed logins per email from all IPs. It slows a guess from many
 * IPs. Only that kind of attack reaches it: one IP stops at five failures. While it is
 * reached, every login for the email is rejected before the password check.
 */
export const LOGIN_EMAIL_CEILING: AttemptRule = { limit: 100, windowMs: 60 * 60 * 1000 };
/** Wrong setup tokens (first-run screen and recovery) from one IP. */
export const SETUP_RULE: AttemptRule = { limit: 5, windowMs: 15 * 60 * 1000 };
/** Restore starts and backup uploads from one IP on the first-run screen (U5). */
export const RESTORE_RULE: AttemptRule = { limit: 10, windowMs: 60 * 60 * 1000 };
/**
 * Wrong backup passphrases over the whole deployment (U5). After five in an hour, the
 * first-run screen refuses every restore start until the hour ends. Each try costs a
 * full key derivation, so this also bounds the Workflow work that a guess can cause.
 */
export const RESTORE_PASSPHRASE_RULE: AttemptRule = { limit: 5, windowMs: 60 * 60 * 1000 };
/** The counter key of RESTORE_PASSPHRASE_RULE: one per deployment. */
export const RESTORE_PASSPHRASE_KEY = "restore-passphrase:deployment";

/** The counters that the auth routes use. Tests can pass another implementation. */
export interface AttemptLimiter {
  check(key: string, rule: AttemptRule): Promise<AttemptStatus>;
  record(key: string, rule: AttemptRule): Promise<AttemptStatus>;
  reset(key: string): Promise<void>;
}

export function durableAttemptLimiter(
  namespace: DurableObjectNamespace<AuthRateLimiter>,
): AttemptLimiter {
  const stub = (key: string) => namespace.getByName(key);
  return {
    check: (key, rule) => stub(key).check(rule),
    record: (key, rule) => stub(key).record(rule),
    reset: (key) => stub(key).reset(),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counter keys. Emails are hashed, so the Durable Object names hold no address. */
export const attemptKeys = {
  ip: (action: string, ip: string) => `${action}:ip:${ip}`,
  email: async (action: string, email: string) =>
    `${action}:email:${await sha256Hex(email.trim().toLowerCase())}`,
};

/** The client IP. Cloudflare sets `CF-Connecting-IP` on every request. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
