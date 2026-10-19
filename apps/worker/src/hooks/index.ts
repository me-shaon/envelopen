import { receiveProviderWebhook, type Services } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { Hono } from "hono";
import { createServices } from "../services";

// Provider webhooks (R43): POST /hooks/<provider>/<workspace id>/<connection id>.
// No session and no API key: each adapter verifies the provider's signature, or the
// secret in the URL or the Basic auth (see packages/providers). Verified events go to
// the `provider_events` hand-off for the event pipeline (packages/core/src/connections/webhooks.ts).
//
// Answers:
// - 200 for a verified request, also when it has no event that Envelopen keeps.
// - 401 for a failed verification, and 404 for an unknown connection. Both record nothing.
// - 413 for a body above 256 KB. Provider events are a few KB.

const MAX_BODY_BYTES = 256 * 1024;

export interface HookRoutesOptions {
  createDb?: (env: Env) => DbConnection;
  createServices?: (env: Env, request: Request) => Partial<Services>;
}

export function createHookRoutes(options: HookRoutesOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/:provider/:workspaceId/:connectionId", async (c) => {
    const provider = c.req.param("provider");
    const workspaceId = Number(c.req.param("workspaceId"));
    const connectionId = Number(c.req.param("connectionId"));
    if (
      !/^[a-z0-9-]{1,40}$/.test(provider) ||
      !Number.isSafeInteger(workspaceId) ||
      !Number.isSafeInteger(connectionId)
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return c.json({ error: "too_large" }, 413);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return c.json({ error: "too_large" }, 413);

    const db = (options.createDb ?? ((env: Env) => createDb(env)))(c.env);
    const services = (options.createServices ?? createServices)(c.env, c.req.raw);
    const outcome = await receiveProviderWebhook(
      { db, services },
      { provider, workspaceId, connectionId },
      {
        url: c.req.url,
        method: "POST",
        headers: c.req.raw.headers,
        body: new TextDecoder().decode(bytes),
      },
    );
    c.executionCtx.waitUntil(db.meter.flush());
    if (outcome.status !== 200) {
      return c.json(
        { error: outcome.status === 401 ? "unauthorized" : "not_found" },
        outcome.status,
      );
    }
    return c.json({ received: outcome.received, stored: outcome.stored });
  });
  app.all("*", (c) => c.json({ error: "not_found" }, 404));
  return app;
}
