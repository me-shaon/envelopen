import { Hono } from "hono";
import { createFileRoutes } from "./api/files";
import { noStore } from "./api/no-store";
import { createFixedWindowLimiter, DEFAULT_API_KEY_RATE_LIMIT } from "./api/rate-limit";
import { createApiRouter } from "./api/router";
import { AUTH_BASE_PATH } from "./auth/better-auth";
import { createAuthRoutes } from "./auth/routes";
import { betterAuthSessionResolver } from "./auth/session";
import { runCron } from "./cron";
import { createHookRoutes } from "./hooks";
import { createMcpRoutes, MCP_PATH } from "./mcp/route";
import { handleSendBatch } from "./queue/send-consumer";
import { createSetupRoutes } from "./setup/first-run";
import { createTrackingRoutes, createUnsubscribeRoutes } from "./tracking";
import { ENVELOPEN_VERSION } from "./version";

// Durable Object and Workflow classes must be exported from the entry module.
export { AuthRateLimiter } from "./auth/rate-limit-do";
export { EventBuffer } from "./do/event-buffer";
export { RateLimiter } from "./do/rate-limiter";
export { UnsubscribeLedger } from "./do/unsubscribe-ledger";
export { UsageMeter } from "./do/usage-meter";
export { BackupWorkflow } from "./workflows/backup-workflow";
export { CampaignWorkflow } from "./workflows/campaign-workflow";
export { ImportWorkflow } from "./workflows/import-workflow";
export { KeyDerivationWorkflow } from "./workflows/key-derivation-workflow";

const app = new Hono<{ Bindings: Env }>();

// No cache may keep an API response. A route that sets its own policy keeps it.
app.use("/api/*", noStore);

app.get("/api/health", (c) => c.json({ status: "ok", version: ENVELOPEN_VERSION }));

// Better Auth (login, passkeys, sessions) and the first-run screen. Both are mounted
// before the API router, whose catch-all would answer their paths with 404. So is the
// file download route.
app.route(AUTH_BASE_PATH, createAuthRoutes());
app.route("/api/setup", createSetupRoutes());
// Signed download links for import error files and exports. No session: the link is the credential.
app.route("/api/files", createFileRoutes());

// One API key budget for REST and MCP. Created once per isolate, so it keeps its counts.
const rateLimiter = createFixedWindowLimiter(DEFAULT_API_KEY_RATE_LIMIT);

// REST API generated from the operation registry, with the OpenAPI document at
// /api/openapi.json.
app.route("/api", createApiRouter({ resolveSession: betterAuthSessionResolver(), rateLimiter }));

// MCP tools generated from the same registry (U16). API keys only, no session.
app.route(MCP_PATH, createMcpRoutes({ rateLimiter }));

// Provider webhooks (U7). Each adapter verifies its own signature or secret.
app.route("/hooks", createHookRoutes());

// Tracking (U10): the open pixel, click redirects, and the honeypot link.
app.route("/t", createTrackingRoutes());
// Unsubscribe and the preference page (U10). One-click POST per RFC 8058.
app.route("/u", createUnsubscribeRoutes());

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
