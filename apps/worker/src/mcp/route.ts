import { principalKey, type Registry, resolveApiKey, type Services } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { createMcpHandler } from "agents/mcp/server";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../api/context";
import { errorJson } from "../api/errors";
import {
  apiKeyRateLimit,
  createFixedWindowLimiter,
  DEFAULT_API_KEY_RATE_LIMIT,
  type RateLimiter,
} from "../api/rate-limit";
import { usageSink } from "../do/usage";
import { createServices } from "../services";
import { createMcpServer, type McpContext } from "./server";

// The MCP endpoint (U16, KTD11): stateless Streamable HTTP with `createMcpHandler` from
// the Agents SDK and an MCP SDK v2 server per request. No Durable Object, no session.
//
// Only an API key authenticates here. The route never reads the session cookie, so a
// browser that is signed in to the admin app cannot call tools. Order for every request:
// database connection, API key (401), rate limit (429, the same limiter as /api), and
// then the MCP handler. The service layer checks the scope of each tool call.

export const MCP_PATH = "/mcp";

export interface McpRouteOptions {
  /** Defaults to the full registry. Tests pass their own. */
  registry?: Registry;
  /** Share it with the API router, so one key has one budget on both surfaces. */
  rateLimiter?: RateLimiter;
  createDb?: (env: Env) => DbConnection;
  createServices?: (env: Env, request: Request) => Partial<Services>;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;
const CONTEXT_KEY = "envelopen";

/** Creates the `/mcp` routes. Mount it with `app.route("/mcp", ...)`. */
export function createMcpRoutes(options: McpRouteOptions = {}) {
  const rateLimiter = options.rateLimiter ?? createFixedWindowLimiter(DEFAULT_API_KEY_RATE_LIMIT);
  const connect = options.createDb ?? ((env: Env) => createDb(env, { usageSink: usageSink(env) }));
  const services = options.createServices ?? createServices;

  const app = new Hono<ApiEnv>();

  app.use("*", async (c, next) => {
    c.set("db", connect(c.env));
    c.set("services", services(c.env, c.req.raw));
    await next();
    flushUsage(c);
  });

  app.use("*", async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const principal = token ? await resolveApiKey(c.var.db, token, { surface: "mcp" }) : null;
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="envelopen"');
      return errorJson(
        c,
        401,
        "unauthenticated",
        "Send an Envelopen API key as `Authorization: Bearer evk_...`.",
      );
    }
    c.set("principal", principal);
    await next();
  });

  app.use("*", apiKeyRateLimit(rateLimiter));

  // One handler per isolate. The factory builds a server per request from the context
  // that the middleware resolved. It travels in `authInfo`, which the SDK passes through
  // without reading it.
  const handler = createMcpHandler(
    ({ authInfo }) => createMcpServer(authInfo?.extra?.[CONTEXT_KEY] as McpContext),
    {
      route: MCP_PATH,
      // The API key is the credential, so CORS has no cookie to protect. The SDK's
      // DNS rebinding checks still guard localhost.
      corsOptions: { origin: "*" },
    },
  );

  app.all("/", (c) => {
    const { principal, db } = c.var;
    const context: McpContext = {
      principal,
      db,
      services: c.var.services,
      ip: c.req.header("cf-connecting-ip") ?? null,
      ...(options.registry ? { registry: options.registry } : {}),
      // A streamed response can outlive this handler, so each call reports its writes.
      afterCall: () => flushUsage(c),
    };
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: "",
        clientId: principalKey(principal),
        scopes: [...principal.scopes],
        extra: { [CONTEXT_KEY]: context },
      },
    });
  });

  return app;
}

/** Reports the rows written so far to the UsageMeter (KTD24), after the response. */
function flushUsage(c: Context<ApiEnv>): void {
  const flush = c.var.db.meter
    .flush()
    .catch((error) => console.error("Usage report failed", error));
  try {
    c.executionCtx.waitUntil(flush);
  } catch {
    // No execution context (a test calling the app directly): the flush runs on its own.
  }
}
