import type { DbConnection } from "@envelopen/db";
import { escapeHtml, rewriteLinks } from "@envelopen/email-render";
import { getAdapter } from "@envelopen/providers";
import { sql } from "kysely";
import { z } from "zod";
import { followUpAvailability } from "../campaigns/follow-up";
import { loadCampaign, sendTracking } from "../campaigns/model";
import { personalizePreview, SAMPLE_VALUES, testLinkOrigin } from "../templates/preview";
import { COUNTERS, type Counter, HOUR_MS, utcHour } from "./rollups";

// Campaign stats (R46, R47, R50, U11). Every number comes from a rollup, never from the
// raw events, so the stats stay after the retention job deletes the events (KTD32, R51):
//
// - `sent` sums the batch counters, the same source as the campaign view's progress.
// - The totals sum `campaign_stats_daily`. Unique opens and clicks count each
//   recipient once, because the flush marks only the first human open and click.
// - The 48-hour view reads `campaign_stats_hourly` from the hour the send started.
// - The click map reads the human clicks of each link from `links.clicks`.
//
// Machine opens and bot clicks are counted apart and never add to the human numbers
// (KTD29). Rates use the sent count as the base. The click-to-open rate divides unique
// human clicks by unique human opens. A provider that sends no delivery events (toSend,
// Cloudflare Email) shows delivered as "not reported": the value is null (R50, AE7).

/** The engagement view covers this many hours from the start of the send (R47). */
export const STATS_WINDOW_HOURS = 48;

const count = z.number().int();
const rate = z
  .number()
  .nullable()
  .meta({ description: "A share from 0 to 1. Null when the base is 0 or not tracked." });

const HourSchema = z
  .object({
    hour: z.number().int().meta({ description: "Start of the UTC hour, Unix milliseconds." }),
    sent: count,
    opens: count.meta({ description: "Human opens in the hour." }),
    uniqueOpens: count,
    machineOpens: count,
    clicks: count.meta({ description: "Human clicks in the hour." }),
    uniqueClicks: count,
  })
  .meta({ id: "CampaignStatsHour" });

export const FollowUpAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable().meta({ description: "Why a follow-up is not available." }),
  })
  .meta({ id: "FollowUpAvailability" });

export const CampaignStatsSchema = z
  .object({
    campaignId: count,
    status: z.string(),
    startedAt: count.nullable(),
    provider: z
      .object({
        provider: z.string(),
        name: z.string(),
        reportsDelivery: z.boolean().meta({
          description: "The provider sends delivery events. When false, delivered is null.",
        }),
      })
      .nullable(),
    tracking: z.object({
      opens: z.boolean().meta({ description: "Open tracking was on for the send." }),
      clicks: z.boolean().meta({ description: "Click tracking was on for the send." }),
    }),
    sent: count,
    delivered: count.nullable().meta({
      description: 'Null means "not reported": the provider sends no delivery events (R50).',
    }),
    uniqueOpens: count.meta({ description: "Recipients with at least one human open." }),
    opens: count.meta({ description: "Human opens, repeats included." }),
    machineOpens: count.meta({
      description: "Opens that a machine made, for example Apple Mail Privacy Protection.",
    }),
    uniqueClicks: count.meta({ description: "Recipients with at least one human click." }),
    clicks: count.meta({ description: "Human clicks, repeats included." }),
    botClicks: count.meta({ description: "Clicks that a scanner made. Not in any rate." }),
    unsubscribes: count,
    bounces: count.meta({ description: "Hard and soft bounces." }),
    bouncesHard: count,
    bouncesSoft: count,
    complaints: count,
    rates: z.object({
      delivered: rate,
      open: rate.meta({ description: "Unique human opens divided by sent." }),
      click: rate.meta({ description: "Unique human clicks divided by sent." }),
      clickToOpen: rate.meta({
        description: "Unique human clicks divided by unique human opens.",
      }),
      unsubscribe: rate,
      bounce: rate,
      complaint: rate,
    }),
    window: z.object({
      start: count.nullable().meta({ description: "The UTC hour the send started." }),
      hours: z.array(HourSchema).meta({
        description: "One entry per hour of the first 48 hours, up to the current hour.",
      }),
    }),
    followUp: FollowUpAvailabilitySchema,
  })
  .meta({ id: "CampaignStats" });

export type CampaignStats = z.input<typeof CampaignStatsSchema>;

type Totals = Record<Counter | "sent", number>;

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

async function totalsOf(db: DbConnection, workspaceId: number, campaignId: number) {
  const [rollup, batches] = await Promise.all([
    db.db
      .selectFrom("campaign_stats_daily")
      .select((eb) => COUNTERS.map((counter) => eb.fn.sum<number>(counter).as(counter)))
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst(),
    db.db
      .selectFrom("campaign_batches")
      .select(sql<number>`COALESCE(SUM(sent_count), 0)`.as("sent"))
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst(),
  ]);
  const totals = { sent: Number(batches?.sent ?? 0) } as Totals;
  for (const counter of COUNTERS) totals[counter] = Number(rollup?.[counter] ?? 0);
  return totals;
}

async function hoursOf(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  start: number,
  now: number,
) {
  const end = start + STATS_WINDOW_HOURS * HOUR_MS;
  const rows = await db.db
    .selectFrom("campaign_stats_hourly")
    .select(["hour", "sent", "opens", "unique_opens", "machine_opens", "clicks", "unique_clicks"])
    .where("workspace_id", "=", workspaceId)
    .where("campaign_id", "=", campaignId)
    .where("hour", ">=", start)
    .where("hour", "<", end)
    .execute();
  const byHour = new Map(rows.map((row) => [Number(row.hour), row]));
  // Up to the current hour, so a campaign sent an hour ago shows one or two bars.
  const last = Math.min(end - HOUR_MS, utcHour(now));
  const hours = [];
  for (let hour = start; hour <= last; hour += HOUR_MS) {
    const row = byHour.get(hour);
    hours.push({
      hour,
      sent: Number(row?.sent ?? 0),
      opens: Number(row?.opens ?? 0),
      uniqueOpens: Number(row?.unique_opens ?? 0),
      machineOpens: Number(row?.machine_opens ?? 0),
      clicks: Number(row?.clicks ?? 0),
      uniqueClicks: Number(row?.unique_clicks ?? 0),
    });
  }
  return hours;
}

export async function campaignStats(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  now: number,
): Promise<CampaignStats> {
  const campaign = await loadCampaign(db, workspaceId, campaignId);
  const [totals, connection] = await Promise.all([
    totalsOf(db, workspaceId, campaignId),
    campaign.connection_id === null
      ? undefined
      : db.db
          .selectFrom("provider_connections")
          .select(["provider", "name"])
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", campaign.connection_id)
          .executeTakeFirst(),
  ]);
  const tracking = await sendTracking(db, campaign);
  const reportsDelivery =
    getAdapter(connection?.provider ?? "")?.capabilities.eventTypes.includes("delivered") ?? false;
  const start = campaign.started_at === null ? null : utcHour(campaign.started_at);
  const hours = start === null ? [] : await hoursOf(db, workspaceId, campaignId, start, now);
  const sent = totals.sent;
  const bounces = totals.bounces_hard + totals.bounces_soft;
  const delivered = reportsDelivery ? totals.delivered : null;
  return {
    campaignId,
    status: campaign.status,
    startedAt: campaign.started_at,
    provider: connection
      ? { provider: connection.provider, name: connection.name, reportsDelivery }
      : null,
    tracking,
    sent,
    delivered,
    uniqueOpens: totals.unique_opens,
    opens: totals.opens,
    machineOpens: totals.machine_opens,
    uniqueClicks: totals.unique_clicks,
    clicks: totals.clicks,
    botClicks: totals.bot_clicks,
    unsubscribes: totals.unsubscribes,
    bounces,
    bouncesHard: totals.bounces_hard,
    bouncesSoft: totals.bounces_soft,
    complaints: totals.complaints,
    rates: {
      delivered: delivered === null ? null : ratio(delivered, sent),
      open: tracking.opens ? ratio(totals.unique_opens, sent) : null,
      click: tracking.clicks ? ratio(totals.unique_clicks, sent) : null,
      clickToOpen:
        tracking.opens && tracking.clicks ? ratio(totals.unique_clicks, totals.unique_opens) : null,
      unsubscribe: ratio(totals.unsubscribes, sent),
      bounce: ratio(bounces, sent),
      complaint: ratio(totals.complaints, sent),
    },
    window: { start, hours },
    followUp: await followUpAvailability(db, campaign, tracking),
  };
}

// Click map (R47) --------------------------------------------------------------------------

export const ClickMapSchema = z
  .object({
    campaignId: count,
    trackClicks: z.boolean(),
    totalClicks: count.meta({ description: "Human clicks on tracked links." }),
    links: z.array(
      z.object({
        index: count.meta({ description: "The link's place among the tracked links." }),
        url: z.string(),
        clicks: count.meta({ description: "Human clicks. Bot clicks are left out." }),
        share: rate.meta({ description: "The link's share of all human clicks." }),
      }),
    ),
    html: z
      .string()
      .nullable()
      .meta({
        description:
          "The stored email HTML with sample values and a click count on each tracked link. " +
          "Render it in a sandboxed frame.",
      }),
  })
  .meta({ id: "CampaignClickMap" });

export type ClickMap = z.input<typeof ClickMapSchema>;

const LINK_ATTRIBUTE = "data-envelopen-link";

function clickLabel(clicks: number): string {
  return `${clicks.toLocaleString("en-US")} ${clicks === 1 ? "click" : "clicks"}`;
}

/**
 * Marks each tracked link of the HTML with its index and adds a style sheet that shows
 * the link's click count next to it. The indexes match `extractLinks`, which numbered
 * the links at send time. No script: the admin app renders the result in a sandboxed
 * frame (KTD27), where CSS still works.
 */
export function annotateClicks(html: string, clicks: ReadonlyMap<number, number>): string {
  // The replacement goes inside the double-quoted href, so it closes the attribute and
  // opens the data attribute. The rewriter adds the closing quote.
  const marked = rewriteLinks(
    html,
    (index, url) => `${escapeHtml(url)}" ${LINK_ATTRIBUTE}="${index}`,
  );
  const rules = [
    `a[${LINK_ATTRIBUTE}]{outline:2px solid #E39A78;outline-offset:2px;border-radius:2px}`,
    `a[${LINK_ATTRIBUTE}]::after{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#FBEADF;color:#7A4614;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;vertical-align:middle;content:"0 clicks"}`,
    ...[...clicks].map(
      ([index, n]) => `a[${LINK_ATTRIBUTE}="${index}"]::after{content:"${clickLabel(n)}"}`,
    ),
  ];
  const style = `<style>${rules.join("\n")}</style>`;
  const head = marked.toLowerCase().indexOf("</head>");
  if (head !== -1) return marked.slice(0, head) + style + marked.slice(head);
  return style + marked;
}

export async function campaignClickMap(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  appOrigin: string | undefined,
): Promise<ClickMap> {
  const campaign = await loadCampaign(db, workspaceId, campaignId);
  const rows = await db.db
    .selectFrom("links")
    .select(["idx", "url", "clicks"])
    .where("workspace_id", "=", workspaceId)
    .where("campaign_id", "=", campaignId)
    .orderBy("idx")
    .execute();
  const total = rows.reduce((sum, row) => sum + Number(row.clicks), 0);
  const counts = new Map(rows.map((row) => [Number(row.idx), Number(row.clicks)]));
  let html: string | null = null;
  if (campaign.html) {
    // Annotate first, on the stored HTML, so the indexes match the ones sent. Then fill
    // the merge tags with sample values, as the preview does.
    const annotated = annotateClicks(campaign.html, counts);
    html = personalizePreview(
      { ...campaign, html: annotated },
      SAMPLE_VALUES,
      testLinkOrigin(appOrigin),
    ).html;
  }
  return {
    campaignId,
    trackClicks: (await sendTracking(db, campaign)).clicks,
    totalClicks: total,
    links: rows.map((row) => ({
      index: Number(row.idx),
      url: row.url,
      clicks: Number(row.clicks),
      share: ratio(Number(row.clicks), total),
    })),
    html,
  };
}
