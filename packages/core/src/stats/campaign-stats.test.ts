import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  addContacts,
  type SeededWorkspace,
  type SentCampaign,
  seedCampaignWorkspace,
  seedSentCampaign,
} from "../../test/campaign-fixtures";
import { createApiKey, testDb, testServices } from "../../test/fixtures";
import { flushEvents } from "../events/flush";
import type { BufferedEvent, TrackingEvent } from "../events/model";
import { runOperation } from "../executor";
import { apiKeyPrincipal, type Principal } from "../principal";
import type { ApiKeyScope } from "../scopes";
import { annotateClicks, type CampaignStats, type ClickMap } from "./campaign-stats";
import { campaignsClickMap, campaignsStats, statsLatest } from "./operations";
import { HOUR_MS } from "./rollups";

// Campaign stats (U11): read from rollups only, machine opens and bot clicks apart,
// "not reported" for providers without delivery events (AE7), the 48-hour view, and
// the click map.

const T0 = Date.UTC(2026, 9, 19, 9, 15);

async function setup(options: { provider?: string; contacts?: number } = {}) {
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, {
    provider: options.provider,
    contacts: options.contacts ?? 4,
  });
  const sent = await seedSentCampaign(db, seeded, { startedAt: T0 });
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = T0 + HOUR_MS) =>
    runOperation(seeded.principal as Principal, op, input, {
      db,
      services,
      now: () => now,
    }) as Promise<T>;
  const stats = (now?: number) => run<CampaignStats>(campaignsStats, { id: sent.campaignId }, now);
  return { db, services, seeded, sent, run, stats };
}

function tracking(
  sent: SentCampaign,
  index: number,
  type: TrackingEvent["type"],
  at: number,
  flags: { machine?: boolean; bot?: boolean; link?: number | null } = {},
): TrackingEvent {
  const recipient = sent.recipients[index];
  if (!recipient) throw new Error(`No recipient ${index}.`);
  return {
    source: "tracking",
    type,
    campaignId: sent.campaignId,
    recipientId: recipient.id,
    contactId: recipient.contactId,
    linkId: type === "click" ? (flags.link ?? sent.linkIds[0] ?? null) : null,
    machine: flags.machine ?? false,
    bot: flags.bot ?? false,
    reason: flags.machine ? "asn" : flags.bot ? "honeypot" : null,
    occurredAt: at,
  };
}

/** A verified provider event as the webhook stores it, ready for the flush. */
async function providerEvent(
  db: ReturnType<typeof testDb>,
  seeded: SeededWorkspace,
  sent: SentCampaign,
  index: number,
  type: "delivered" | "bounce_hard" | "bounce_soft" | "complaint",
  at: number,
): Promise<BufferedEvent> {
  const recipient = sent.recipients[index];
  if (!recipient) throw new Error(`No recipient ${index}.`);
  const row = await db.db
    .insertInto("provider_events")
    .values({
      workspace_id: seeded.workspaceId,
      connection_id: seeded.connectionId,
      provider: "test",
      event_id: `${type}-${recipient.id}-${at}`,
      type,
      provider_message_id: recipient.messageId,
      email_hash: null,
      detail: null,
      occurred_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return {
    source: "provider",
    id: row.id,
    type,
    providerMessageId: recipient.messageId,
    emailHash: null,
    occurredAt: at,
  };
}

describe("campaign stats", () => {
  it("covers AE7: a toSend campaign shows delivered as not reported, and the other metrics show values", async () => {
    const { db, seeded, sent, stats } = await setup({ provider: "tosend" });
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        tracking(sent, 0, "open", T0 + 60_000),
        tracking(sent, 0, "click", T0 + 120_000),
        tracking(sent, 1, "unsubscribe", T0 + 180_000),
        await providerEvent(db, seeded, sent, 2, "complaint", T0 + 240_000),
        await providerEvent(db, seeded, sent, 3, "bounce_hard", T0 + 240_000),
      ],
      T0 + 300_000,
    );
    const result = await stats();
    expect(result.provider).toMatchObject({ provider: "tosend", reportsDelivery: false });
    expect(result.delivered).toBeNull();
    expect(result.rates.delivered).toBeNull();
    expect(result).toMatchObject({
      sent: 4,
      uniqueOpens: 1,
      uniqueClicks: 1,
      unsubscribes: 1,
      complaints: 1,
      bounces: 1,
      bouncesHard: 1,
    });
    expect(result.rates).toMatchObject({ open: 0.25, click: 0.25, clickToOpen: 1 });
  });

  it("reports delivered for a provider with delivery events", async () => {
    const { db, seeded, sent, stats } = await setup({ provider: "resend" });
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        await providerEvent(db, seeded, sent, 0, "delivered", T0 + 1000),
        await providerEvent(db, seeded, sent, 1, "delivered", T0 + 1000),
        await providerEvent(db, seeded, sent, 2, "delivered", T0 + 1000),
      ],
      T0 + 5000,
    );
    const result = await stats();
    expect(result.provider?.reportsDelivery).toBe(true);
    expect(result.delivered).toBe(3);
    expect(result.rates.delivered).toBe(0.75);
  });

  it("computes the click-to-open rate from unique human opens only", async () => {
    const { db, seeded, sent, stats } = await setup();
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        // Recipient 0 opens twice and clicks. Recipient 1 has a machine open and a human
        // click. Recipient 2 has a machine open and a bot click. Recipient 3 opens.
        tracking(sent, 0, "open", T0 + 1000),
        tracking(sent, 0, "open", T0 + 2000),
        tracking(sent, 0, "click", T0 + 3000),
        tracking(sent, 1, "open", T0 + 1000, { machine: true }),
        tracking(sent, 1, "click", T0 + 90_000),
        tracking(sent, 2, "open", T0 + 1000, { machine: true }),
        tracking(sent, 2, "click", T0 + 1500, { bot: true }),
        tracking(sent, 3, "open", T0 + 4000),
      ],
      T0 + 100_000,
    );
    const result = await stats();
    expect(result).toMatchObject({
      uniqueOpens: 2,
      opens: 3,
      machineOpens: 2,
      uniqueClicks: 2,
      clicks: 2,
      botClicks: 1,
    });
    // Two unique human clicks over two unique human opens. With the machine opens in
    // the base it would be 2 over 4.
    expect(result.rates.clickToOpen).toBe(1);
    expect(result.rates.open).toBe(0.5);
  });

  it("shows the first 48 hours by the hour, from the hour the send started", async () => {
    const { db, seeded, sent, stats } = await setup();
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        tracking(sent, 0, "open", T0 + 10 * 60_000),
        tracking(sent, 1, "open", T0 + 3 * HOUR_MS),
        tracking(sent, 1, "click", T0 + 3 * HOUR_MS + 1000),
        // After the window: it counts in the totals, not in the 48-hour view.
        tracking(sent, 2, "open", T0 + 50 * HOUR_MS),
      ],
      T0 + 51 * HOUR_MS,
    );
    const start = Math.floor(T0 / HOUR_MS) * HOUR_MS;
    const early = await stats(T0 + 3 * HOUR_MS + 5000);
    expect(early.window.start).toBe(start);
    expect(early.window.hours).toHaveLength(4);
    const full = await stats(T0 + 60 * HOUR_MS);
    expect(full.window.hours).toHaveLength(48);
    expect(full.window.hours[0]).toMatchObject({ hour: start, sent: 4, opens: 1, uniqueOpens: 1 });
    expect(full.window.hours[3]).toMatchObject({ opens: 1, clicks: 1, uniqueClicks: 1 });
    const inWindow = full.window.hours.reduce((sum, hour) => sum + hour.opens, 0);
    expect(inWindow).toBe(2);
    expect(full.uniqueOpens).toBe(3);
  });

  it("shows human clicks per link on the stored HTML", async () => {
    const { db, seeded, sent, run } = await setup();
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        tracking(sent, 0, "click", T0 + 90_000),
        tracking(sent, 1, "click", T0 + 90_000),
        tracking(sent, 1, "click", T0 + 95_000),
        tracking(sent, 2, "click", T0 + 1000, { bot: true }),
      ],
      T0 + 100_000,
    );
    const map = await run<ClickMap>(campaignsClickMap, { id: sent.campaignId });
    expect(map.trackClicks).toBe(true);
    expect(map.totalClicks).toBe(3);
    expect(map.links).toEqual([
      { index: 0, url: "https://example.com/course", clicks: 3, share: 1 },
    ]);
    expect(map.html).toContain('href="https://example.com/course" data-envelopen-link="0"');
    expect(map.html).toContain('a[data-envelopen-link="0"]::after{content:"3 clicks"}');
    // Sample values fill the merge tags, as in the preview. The unsubscribe link is not tracked.
    expect(map.html).toContain("Hello Ada");
    expect(map.html?.match(/ data-envelopen-link=/g)).toHaveLength(1);
  });

  it("annotates links by the same index as the send, and adds no script", () => {
    const html =
      '<html><head><title>x</title></head><body><a href="mailto:a@example.com">Mail</a>' +
      '<a href="https://a.example/?x=1&amp;y=2">A</a><a href="https://b.example/{{ first_name }}">B</a>' +
      '<a href="https://c.example/">C</a></body></html>';
    const out = annotateClicks(html, new Map([[1, 12]]));
    expect(out).toContain('href="https://a.example/?x=1&amp;y=2" data-envelopen-link="0"');
    expect(out).toContain('href="https://c.example/" data-envelopen-link="1"');
    expect(out).toContain('content:"12 clicks"');
    expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("</head>"));
    expect(out).not.toMatch(/<script/i);
  });

  it("reads with stats:read and refuses a key without it", async () => {
    const { db, services, seeded, sent } = await setup();
    const reader = await createApiKey(db, seeded.workspaceId, ["stats:read"]);
    const other = await createApiKey(db, seeded.workspaceId, ["campaigns:read"]);
    const principal = (id: number, scopes: ApiKeyScope[]) =>
      apiKeyPrincipal({ workspaceId: seeded.workspaceId, apiKeyId: id, scopes, surface: "rest" });
    const deps = { db, services, now: () => T0 + HOUR_MS };
    await expect(
      runOperation(
        principal(reader.id, ["stats:read"]),
        campaignsStats,
        { id: sent.campaignId },
        deps,
      ),
    ).resolves.toMatchObject({ sent: 4 });
    await expect(
      runOperation(
        principal(other.id, ["campaigns:read"]),
        campaignsStats,
        { id: sent.campaignId },
        deps,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns the campaign that started last for the overview", async () => {
    const { db, seeded, run } = await setup();
    const later = await seedSentCampaign(db, seeded, { startedAt: T0 + HOUR_MS });
    const latest = await run<{ campaign: { id: number } | null; stats: CampaignStats | null }>(
      statsLatest,
      {},
    );
    expect(latest.campaign?.id).toBe(later.campaignId);
    expect(latest.stats?.sent).toBe(4);
  });

  it("matches the event counts in the database for an F1-style campaign", async () => {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services, {
      provider: "resend",
      contacts: 0,
    });
    await addContacts(db, services.hashEmail, seeded.workspaceId, seeded.listId, 60);
    const sent = await seedSentCampaign(db, seeded, { startedAt: T0 });

    // A deterministic mix over several flushes: deliveries, human and machine opens with
    // repeats, human and bot clicks, unsubscribes, bounces, and complaints.
    let at = T0 + 1000;
    for (let round = 0; round < 3; round++) {
      const events: BufferedEvent[] = [];
      for (let i = 0; i < sent.recipients.length; i++) {
        at += 1000;
        const key = (i * 7 + round * 3) % 10;
        if (round === 0 && i % 5 !== 4) {
          events.push(await providerEvent(db, seeded, sent, i, "delivered", at));
        }
        if (key < 4) events.push(tracking(sent, i, "open", at));
        if (key === 4 || key === 5) events.push(tracking(sent, i, "open", at, { machine: true }));
        if (key < 2) events.push(tracking(sent, i, "click", at + 90_000));
        if (key === 6) events.push(tracking(sent, i, "click", at, { bot: true }));
        if (round === 2 && i % 13 === 0) events.push(tracking(sent, i, "unsubscribe", at));
        if (round === 1 && i % 17 === 0) {
          events.push(await providerEvent(db, seeded, sent, i, "bounce_soft", at));
        }
        if (round === 2 && i % 19 === 0) {
          events.push(await providerEvent(db, seeded, sent, i, "complaint", at));
        }
      }
      // The flush takes at most 200 events at once, as the buffer does.
      for (let i = 0; i < events.length; i += 200) {
        await flushEvents(db, seeded.workspaceId, events.slice(i, i + 200), at);
      }
    }

    const run = (op: Parameters<typeof runOperation>[1]) =>
      runOperation(
        seeded.principal,
        op,
        { id: sent.campaignId },
        {
          db,
          services,
          now: () => at,
        },
      );
    const stats = (await run(campaignsStats)) as CampaignStats;
    const map = (await run(campaignsClickMap)) as ClickMap;

    const ws = seeded.workspaceId;
    const campaignId = sent.campaignId;
    const one = async (query: ReturnType<typeof sql<{ n: number }>>) =>
      Number((await query.execute(db.db)).rows[0]?.n ?? 0);
    const events = (where: ReturnType<typeof sql>) =>
      one(
        sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM email_events WHERE workspace_id = ${ws} AND campaign_id = ${campaignId} AND ${where}`,
      );
    const recipients = (where: ReturnType<typeof sql>) =>
      one(
        sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM campaign_recipients WHERE workspace_id = ${ws} AND campaign_id = ${campaignId} AND ${where}`,
      );

    const expected = {
      sent: await recipients(sql`status = 'sent'`),
      delivered: await events(sql`type = 'delivered'`),
      uniqueOpens: await recipients(sql`opened_at IS NOT NULL`),
      opens: await events(sql`type = 'open' AND is_machine = 0`),
      machineOpens: await events(sql`type = 'open' AND is_machine = 1`),
      uniqueClicks: await recipients(sql`clicked_at IS NOT NULL`),
      clicks: await events(sql`type = 'click' AND is_bot = 0`),
      botClicks: await events(sql`type = 'click' AND is_bot = 1`),
      unsubscribes: await events(sql`type = 'unsubscribe'`),
      bouncesSoft: await events(sql`type = 'bounce_soft'`),
      bouncesHard: await events(sql`type = 'bounce_hard'`),
      complaints: await events(sql`type = 'complaint'`),
    };
    expect(stats).toMatchObject(expected);
    expect(expected.sent).toBe(60);
    // Every kind of event happened, so the comparison covers each counter.
    for (const key of ["delivered", "uniqueOpens", "machineOpens", "uniqueClicks", "botClicks"]) {
      expect(expected[key as keyof typeof expected]).toBeGreaterThan(0);
    }
    expect(expected.opens).toBeGreaterThan(expected.uniqueOpens);
    expect(map.totalClicks).toBe(expected.clicks);
    expect(stats.window.hours.reduce((sum, hour) => sum + hour.opens, 0)).toBe(expected.opens);
  });
});
