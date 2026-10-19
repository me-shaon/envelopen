import { createDb } from "@envelopen/db";
import { Hono } from "hono";
import { purgeExpiredIdempotencyKeys } from "./api/idempotency";
import { createApiRouter } from "./api/router";
import { AUTH_BASE_PATH } from "./auth/better-auth";
import { createAuthRoutes } from "./auth/routes";
import { betterAuthSessionResolver } from "./auth/session";
import { createSetupRoutes } from "./setup/first-run";

// Durable Object classes must be exported from the entry module.
export { AuthRateLimiter } from "./auth/rate-limit-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Better Auth (login, passkeys, sessions) and the first-run screen. Both are mounted
// before the API router, whose catch-all would answer their paths with 404.
app.route(AUTH_BASE_PATH, createAuthRoutes());
app.route("/api/setup", createSetupRoutes());

// REST API generated from the operation registry, with the OpenAPI document at
// /api/openapi.json. Created once per isolate, so the rate limiter keeps its counts.
app.route("/api", createApiRouter({ resolveSession: betterAuthSessionResolver() }));

// Placeholder for the unsubscribe and preference pages (U10).
app.get("/u/:token", (c) => c.text("Envelopen subscription page"));

export default {
  fetch: app.fetch,

  async queue(batch, _env, _ctx) {
    // The send consumer (U9) replaces this stub.
    batch.ackAll();
  },

  async scheduled(_controller, env, _ctx) {
    // The recovery sweep (U9) joins this handler.
    await purgeExpiredIdempotencyKeys(createDb(env));
  },
} satisfies ExportedHandler<Env>;
