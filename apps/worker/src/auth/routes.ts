import { createDb } from "@envelopen/db";
import { type Context, Hono } from "hono";
import { AUTH_BASE_PATH, authSettings, createAuth } from "./better-auth";
import {
  type AttemptLimiter,
  type AttemptStatus,
  attemptKeys,
  clientIp,
  durableAttemptLimiter,
  LOGIN_RULE,
} from "./rate-limit-do";

type AuthAppEnv = { Bindings: Env };

export interface AuthRoutesOptions {
  /** Defaults to the AuthRateLimiter Durable Object. */
  limiter?: (env: Env) => AttemptLimiter;
  /** Defaults to the origin of the request URL, like the API origin check. */
  appOrigin?: (c: Context<AuthAppEnv>) => string;
}

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
 * Failed logins count per IP and per email in the AuthRateLimiter Durable Object. The
 * sixth failure in the window is rejected with 429 before Better Auth runs, so a
 * blocked attempt costs no password hash.
 */
export function createAuthRoutes(options: AuthRoutesOptions = {}): Hono<AuthAppEnv> {
  const limiterFor = options.limiter ?? defaultLimiter;
  const appOrigin = options.appOrigin ?? ((c) => new URL(c.req.url).origin);
  const app = new Hono<AuthAppEnv>();

  // The login page asks which method to show (KTD7).
  app.get("/mode", (c) => c.json({ loginMode: authSettings(c.env).loginMode }));

  app.on(["GET", "POST"], "/*", async (c) => {
    const request = c.req.raw;
    const auth = await createAuth({
      env: c.env,
      origin: appOrigin(c),
      d1: createDb(c.env).d1,
    });
    const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
    if (request.method !== "POST" || !LOGIN_PATHS.has(path)) return auth.handler(request);

    const limiter = limiterFor(c.env);
    const keys = [attemptKeys.ip("login", clientIp(request))];
    const email = path === "/sign-in/email" ? await emailOf(request) : null;
    if (email !== null) keys.push(await attemptKeys.email("login", email));

    const statuses = await Promise.all(keys.map((key) => limiter.check(key, LOGIN_RULE)));
    const blocked = statuses.find((status) => !status.allowed);
    if (blocked) return tooManyAttempts(blocked);

    const response = await auth.handler(request);
    if (response.status >= 400 && response.status < 500) {
      await Promise.all(keys.map((key) => limiter.record(key, LOGIN_RULE)));
    } else if (response.ok && keys[1] !== undefined) {
      // A successful login clears the email's count. The IP's count stays.
      await limiter.reset(keys[1]);
    }
    return response;
  });

  return app;
}
