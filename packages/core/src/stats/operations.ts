import { z } from "zod";
import { defineOperation } from "../registry/operation";
import {
  CampaignStatsSchema,
  ClickMapSchema,
  campaignClickMap,
  campaignStats,
} from "./campaign-stats";

// Stats operations (R46, R47, R50). They read rollups only and need `stats:read`, the
// scope of the "Agent read-only" preset.

const STATS_MCP = {
  class: "now",
  reason: "Stats and usage are in the plan's MCP 'now' set. They read rollups and change nothing.",
} as const;

const idInput = z.object({ id: z.coerce.number().int().positive() });

export const campaignsStats = defineOperation({
  id: "campaigns.stats",
  summary: "Get a campaign's stats",
  description:
    "Returns sent, delivered, bounces, complaints, unsubscribes, unique human opens, machine " +
    "opens, unique human clicks, the open, click, and click-to-open rates, and the hourly " +
    "engagement of the first 48 hours. Delivered is null when the provider sends no " +
    'delivery events ("not reported"). Events reach the stats within about a minute.',
  method: "get",
  path: "/campaigns/{id}/stats",
  scope: "stats:read",
  risk: "read",
  mcp: STATS_MCP,
  input: idInput,
  output: CampaignStatsSchema,
  handler: (input, { principal, db, now }) =>
    campaignStats(db, principal.workspaceId, input.id, now),
});

export const campaignsClickMap = defineOperation({
  id: "campaigns.click_map",
  summary: "Get a campaign's click map",
  description:
    "Returns the human clicks of each tracked link, and the email HTML with each link's " +
    "count next to it, for a sandboxed preview.",
  method: "get",
  path: "/campaigns/{id}/click-map",
  scope: "stats:read",
  risk: "read",
  mcp: STATS_MCP,
  input: idInput,
  output: ClickMapSchema,
  handler: (input, { principal, db, services }) =>
    campaignClickMap(db, principal.workspaceId, input.id, services.appOrigin),
});

const LatestSchema = z
  .object({
    campaign: z
      .object({
        id: z.number().int(),
        name: z.string(),
        status: z.string(),
        startedAt: z.number().int().nullable(),
        recipientCount: z.number().int().nullable(),
      })
      .nullable()
      .meta({ description: "The campaign that started last. Null before the first send." }),
    stats: CampaignStatsSchema.nullable(),
  })
  .meta({ id: "LatestCampaignStats" });

export const statsLatest = defineOperation({
  id: "stats.latest",
  summary: "Get the latest campaign's stats",
  description: "Returns the stats of the campaign that started last, for the overview.",
  method: "get",
  path: "/stats/latest",
  scope: "stats:read",
  risk: "read",
  mcp: STATS_MCP,
  input: z.object({}),
  output: LatestSchema,
  async handler(_input, { principal, db, now }) {
    const row = await db.db
      .selectFrom("campaigns")
      .select(["id", "name", "status", "started_at", "recipient_count"])
      .where("workspace_id", "=", principal.workspaceId)
      .where("started_at", "is not", null)
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return { campaign: null, stats: null };
    return {
      campaign: {
        id: row.id,
        name: row.name,
        status: row.status,
        startedAt: row.started_at,
        recipientCount: row.recipient_count,
      },
      stats: await campaignStats(db, principal.workspaceId, row.id, now),
    };
  },
});
