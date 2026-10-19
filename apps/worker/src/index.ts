import { cleanupExpiredFiles } from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { Hono } from "hono";
import { createFileRoutes } from "./api/files";
import { purgeExpiredIdempotencyKeys } from "./api/idempotency";
import { createApiRouter } from "./api/router";
import { AUTH_BASE_PATH } from "./auth/better-auth";
import { createAuthRoutes } from "./auth/routes";
import { betterAuthSessionResolver } from "./auth/session";
import { createHookRoutes } from "./hooks";
import { createSetupRoutes } from "./setup/first-run";

// Durable Object and Workflow classes must be exported from the entry module.
export { AuthRateLimiter } from "./auth/rate-limit-do";
export { ImportWorkflow } from "./workflows/import-workflow";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Better Auth (login, passkeys, sessions) and the first-run screen. Both are mounted
// before the API router, whose catch-all would answer their paths with 404. So is the
// file download route.
app.route(AUTH_BASE_PATH, createAuthRoutes());
app.route("/api/setup", createSetupRoutes());
// Signed download links for import error files and exports. No session: the link is the credential.
app.route("/api/files", createFileRoutes());

// REST API generated from the operation registry, with the OpenAPI document at
// /api/openapi.json. Created once per isolate, so the rate limiter keeps its counts.
app.route("/api", createApiRouter({ resolveSession: betterAuthSessionResolver() }));

// Provider webhooks (U7). Each adapter verifies its own signature or secret.
app.route("/hooks", createHookRoutes());

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
    const db = createDb(env);
    await purgeExpiredIdempotencyKeys(db);
    // Uploads, error files, and exports that hold contact data expire after 24 hours.
    await cleanupExpiredFiles(db, env.BUCKET);
  },
} satisfies ExportedHandler<Env>;
