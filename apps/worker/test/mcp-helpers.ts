import { env } from "cloudflare:workers";
import type { Services } from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { createMcpRoutes, MCP_PATH, type McpRouteOptions } from "../src/mcp/route";
import { ORIGIN } from "./helpers";

// MCP tests run the real /mcp route with the MCP SDK client. The client's fetch calls
// the Hono app in process, so a test needs no running Worker and no network.

export const MCP_URL = `${ORIGIN}${MCP_PATH}`;

export interface McpTestApp {
  request(init?: RequestInit): Promise<Response>;
  /** Connects an MCP client that sends the key as a Bearer token. */
  connect(key: string): Promise<Client>;
}

export function createMcpTestApp(
  options: McpRouteOptions & { services?: Partial<Services> } = {},
): McpTestApp {
  const { services = {}, ...routeOptions } = options;
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    MCP_PATH,
    createMcpRoutes({
      createDb: (bindings) => createDb(bindings, { enforceWorkspaceScope: true }),
      createServices: () => services,
      ...routeOptions,
    }),
  );
  const fetchApp = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      app.request(input instanceof Request ? input : String(input), init, env as Env),
    );
  return {
    request: (init = {}) => fetchApp(MCP_URL, init),
    async connect(key) {
      const client = new Client({ name: "envelopen-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        fetch: fetchApp,
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      });
      await client.connect(transport);
      return client;
    },
  };
}

/** A JSON-RPC `tools/list` request body, for tests that check the raw HTTP answer. */
export function rpc(method: string, params: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}
