import { Hono } from "hono";
import { createFileRoutes } from "./api/files";
import { createApiRouter } from "./api/router";
import { AUTH_BASE_PATH } from "./auth/better-auth";
import { createAuthRoutes } from "./auth/routes";
import { betterAuthSessionResolver } from "./auth/session";
import { runCron } from "./cron";
import { createHookRoutes } from "./hooks";
import { handleSendBatch } from "./queue/send-consumer";
import { createSetupRoutes } from "./setup/first-run";

// Durable Object and Workflow classes must be exported from the entry module.
export { AuthRateLimiter } from "./auth/rate-limit-do";
export { RateLimiter } from "./do/rate-limiter";
export { UsageMeter } from "./do/usage-meter";
export { CampaignWorkflow } from "./workflows/campaign-workflow";
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

  // The send consumer (U9): one batch pointer per invocation.
  async queue(batch, env) {
    await handleSendBatch(batch, env);
  },

  // Due campaigns, the recovery sweep, the resume after the D1 limit, and cleanup.
  async scheduled(controller, env, ctx) {
    await runCron(env, ctx, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
