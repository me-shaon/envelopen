import { createDb } from "@envelopen/db";
import { type Context, Hono } from "hono";
import { readBodyLimited, withBody } from "../body";
import { AUTH_BASE_PATH, authSettings, createAuth } from "./better-auth";
import {
  type AttemptLimiter,
  type AttemptStatus,
  attemptKeys,
  clientIp,
  durableAttemptLimiter,
  LOGIN_EMAIL_CEILING,
  LOGIN_RULE,
} from "./rate-limit-do";

type AuthAppEnv = { Bindings: Env };

export interface AuthRoutesOptions {
  /** Defaults to the AuthRateLimiter Durable Object. */
  limiter?: (env: Env) => AttemptLimiter;
  /** Defaults to the origin of the request URL, like the API origin check. */
  appOrigin?: (c: Context<AuthAppEnv>) => string;
}

/** Auth requests carry an email and a password, or a WebAuthn response of a few KB. */
const MAX_AUTH_BODY_BYTES = 64 * 1024;

/** Login endpoints whose failures count toward the limit (KTD8). */
const LOGIN_PATHS = new Set(["/sign-in/email", "/passkey/verify-authentication"]);

export function defaultLimiter(env: Env): AttemptLimiter {
  return durableAttemptLimiter(env.AUTH_RATE_LIMITER);
}

export function tooManyAttempts(status: AttemptStatus): Response {
  const seconds = Math.max(1, Math.ceil(status.retryAfterMs / 1000));
  // Better Auth's error shape, so its client shows the message.
  return Response.json(
    { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Try again later." },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

async function emailOf(request: Request): Promise<string | null> {
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    return typeof body.email === "string" && body.email.length <= 320 ? body.email : null;
  } catch {
    return null;
  }
}

/**
 * The Better Auth routes under `/api/auth`, plus `GET /api/auth/mode`. Mount the
 * result with `app.route(AUTH_BASE_PATH, createAuthRoutes())`, before the API router.
 *
 * Failed logins count per IP and per email in the AuthRateLimiter Durable Object.
 * - Per IP: after five failures, every login is rejected with 429 before Better Auth
 *   runs, so a blocked attempt costs no password hash.
 * - Per email: after five failures, a further failure gets 429 instead of 401. The right
 *   password still signs in, so failures from other IPs cannot lock the owner out.
 * - Per email, from all IPs: a high ceiling (LOGIN_EMAIL_CEILING) rejects every login
 *   before Better Auth runs, to slow a guess from many IPs.
 * Every path runs the same password check, and an unknown email counts like a known one,
 * so the responses do not tell which emails exist.
 */
export function createAuthRoutes(options: AuthRoutesOptions = {}): Hono<AuthAppEnv> {
  const limiterFor = options.limiter ?? defaultLimiter;
  const appOrigin = options.appOrigin ?? ((c) => new URL(c.req.url).origin);
  const app = new Hono<AuthAppEnv>();

  // The login page asks which method to show (KTD7).
  app.get("/mode", (c) => c.json({ loginMode: authSettings(c.env).loginMode }));

  app.on(["GET", "POST"], "/*", async (c) => {
    let request = c.req.raw;
    if (request.method === "POST") {
      // Counted while reading, so a chunked body without Content-Length is capped too.
      const bytes = await readBodyLimited(request, MAX_AUTH_BODY_BYTES);
      if (!bytes) {
        return Response.json(
          { code: "BODY_TOO_LARGE", message: "The request body is too large." },
          { status: 413 },
        );
      }
      request = withBody(request, bytes);
    }
    const auth = await createAuth({
      env: c.env,
      origin: appOrigin(c),
      d1: createDb(c.env).d1,
    });
    const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
    if (request.method !== "POST" || !LOGIN_PATHS.has(path)) return auth.handler(request);

    const limiter = limiterFor(c.env);
    const ipKey = attemptKeys.ip("login", clientIp(request));
    const email = path === "/sign-in/email" ? await emailOf(request) : null;
    const emailKeys =
      email === null
        ? null
        : {
            soft: await attemptKeys.email("login", email),
            ceiling: await attemptKeys.email("login-ceiling", email),
          };

    // Checked before the password: the IP limit and the per-email ceiling.
    const statuses = await Promise.all([
      limiter.check(ipKey, LOGIN_RULE),
      ...(emailKeys ? [limiter.check(emailKeys.ceiling, LOGIN_EMAIL_CEILING)] : []),
    ]);
    const blocked = statuses.find((status) => !status.allowed);
    if (blocked) return tooManyAttempts(blocked);

    const response = await auth.handler(request);
    if (response.status >= 400 && response.status < 500) {
      const [, soft] = await Promise.all([
        limiter.record(ipKey, LOGIN_RULE),
        emailKeys ? limiter.record(emailKeys.soft, LOGIN_RULE) : null,
        emailKeys ? limiter.record(emailKeys.ceiling, LOGIN_EMAIL_CEILING) : null,
      ]);
      // The per-email limit rejects failures only: the sixth and later failures get 429.
      // The right password always gets past it.
      if (soft && soft.count > LOGIN_RULE.limit) return tooManyAttempts(soft);
    } else if (response.ok && emailKeys) {
      // A successful login clears the email's counts. The IP's count stays.
      await Promise.all([limiter.reset(emailKeys.soft), limiter.reset(emailKeys.ceiling)]);
    }
    return response;
  });

  return app;
}
