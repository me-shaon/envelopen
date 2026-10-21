import { z } from "zod";
import { defineOperation } from "../registry/operation";
import { requireService } from "../services";
import { readWorkersPlan } from "../settings/operations";
import { UsageSchema, usageView } from "./view";

export const usageGet = defineOperation({
  id: "usage.get",
  summary: "Get the platform usage",
  description:
    "Returns today's D1 rows written on the deployment, the rows left before the Workers " +
    "Free limit, the reset time (00:00 UTC), and the platform_limit pause when it is in force. " +
    "It also gives the Workers plan that the owner set, the reserved threshold where welcome " +
    "steps wait (70% on Free), and the writes that welcome steps made today. " +
    "The D1 limit is per Cloudflare account, so every workspace sees the same numbers.",
  method: "get",
  path: "/usage",
  scope: "stats:read",
  risk: "read",
  mcp: {
    class: "now",
    reason: "Stats and usage are in the plan's MCP 'now' set. Agents check the budget first.",
  },
  input: z.object({}),
  output: UsageSchema,
  async handler(_input, { db, services, now }) {
    const [status, plan] = await Promise.all([
      requireService(services, "usage").status(),
      readWorkersPlan(db),
    ]);
    return usageView(status, now, plan);
  },
});
