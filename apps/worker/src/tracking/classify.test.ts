import { flushEvents, type TrackingEvent } from "@envelopen/core";
import { describe, expect, it } from "vitest";
import { campaignDb, sendingCampaign, testDeps } from "../../test/campaign-helpers";
import {
  call,
  LATER,
  mount,
  pathOf,
  recordingDeps,
  SENT_AT,
  sentCampaign,
} from "../../test/tracking-helpers";
import { processPointer } from "../queue/send-consumer";
import {
  APPLE_ASN,
  BOT_WINDOW_MS,
  classifyClick,
  classifyOpen,
  type Hit,
  hitOf,
  markBursts,
} from "./classify";
import { createTrackingRoutes } from "./index";
import { PIXEL_GIF } from "./pixel";

// Classification (KTD29) and the tracking routes. Each test checks the route's answer
// and the events it hands to the buffer. The report tests flush those events into D1
// and read the rollups, which is what the dashboards read.

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function hit(overrides: Partial<Hit> = {}): Hit {
  return {
    method: "GET",
    userAgent: BROWSER,
    asn: 7922,
    asOrganization: "Comcast",
    prefetch: false,
    ...overrides,
  };
}

describe("classifyOpen", () => {
  it("covers AE6: an open from ASN 714 with a bare user agent is a machine open", () => {
    expect(classifyOpen(hit({ asn: APPLE_ASN, userAgent: "Mozilla/5.0" }))).toEqual({
      flagged: true,
      reason: "apple_privacy_proxy",
    });
    // A person on Apple's network with a full browser user agent is a human open.
    expect(classifyOpen(hit({ asn: APPLE_ASN }))).toEqual({ flagged: false, reason: null });
    expect(classifyOpen(hit())).toEqual({ flagged: false, reason: null });
  });

  it("flags HEAD requests, prefetches, and requests without a user agent", () => {
    expect(classifyOpen(hit({ method: "HEAD" })).flagged).toBe(true);
    expect(classifyOpen(hit({ prefetch: true })).flagged).toBe(true);
    expect(classifyOpen(hit({ userAgent: "" })).flagged).toBe(true);
  });

  it("reads the ASN, the user agent, and the purpose from the request", () => {
    const request = new Request("https://envelopen.test/t/o/x", {
      method: "HEAD",
      headers: { "user-agent": "Mozilla/5.0", "sec-purpose": "prefetch" },
      cf: { asn: 714, asOrganization: "Apple Inc." },
    });
    expect(hitOf(request)).toEqual({
      method: "HEAD",
      userAgent: "Mozilla/5.0",
      asn: 714,
      asOrganization: "Apple Inc.",
      prefetch: true,
    });
  });
});

describe("classifyClick", () => {
  const context = { honeypot: false, sentAt: SENT_AT, now: LATER };

  it("flags a HEAD request, a honeypot hit, a scanner network, and a click in the bot window", () => {
    expect(classifyClick(hit({ method: "HEAD" }), context).reason).toBe("head");
    expect(classifyClick(hit(), { ...context, honeypot: true }).reason).toBe("honeypot");
    expect(classifyClick(hit({ asn: 22843 }), context).reason).toBe("scanner_network");
    expect(classifyClick(hit({ asn: 1, asOrganization: "Mimecast Ltd" }), context).reason).toBe(
      "scanner_network",
    );
    expect(classifyClick(hit(), { ...context, now: SENT_AT + BOT_WINDOW_MS - 1 }).reason).toBe(
      "bot_window",
    );
    expect(classifyClick(hit(), context)).toEqual({ flagged: false, reason: null });
  });

  it("marks same-second bursts and clicks near a honeypot hit as bot clicks", () => {
    const base: TrackingEvent = {
      source: "tracking",
      type: "click",
      campaignId: 1,
      recipientId: 7,
      contactId: 3,
      linkId: 1,
      machine: false,
      bot: false,
      reason: null,
      occurredAt: LATER,
    };
    const burst = markBursts([
      base,
      { ...base, linkId: 2, occurredAt: LATER + 300 },
      // Another recipient in the same second is a person.
      { ...base, recipientId: 8, linkId: 2 },
    ]);
    expect(burst.map((event) => event.source === "tracking" && event.bot)).toEqual([
      true,
      true,
      false,
    ]);
    const near = markBursts([
      { ...base, linkId: null, bot: true, reason: "honeypot" },
      { ...base, occurredAt: LATER + 1500 },
      { ...base, occurredAt: LATER + 60_000 },
    ]);
    expect(near.map((event) => event.source === "tracking" && event.reason)).toEqual([
      "honeypot",
      "near_honeypot",
      null,
    ]);
  });
});

describe("tracking routes", () => {
  it("returns the pixel and records an open, and a machine open from Apple's proxy", async () => {
    const sent = await sentCampaign();
    const deps = await recordingDeps(sent.db);
    const app = mount("/t", createTrackingRoutes({ deps: () => deps }));
    const pixel = sent.emails[0]?.html.match(/https:\/\/envelopen\.test(\/t\/o\/[^"]+)"/)?.[1];
    expect(pixel).toBeDefined();
    const human = await call(app, pixel as string, { headers: { "user-agent": BROWSER } });
    expect(human.status).toBe(200);
    expect(human.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await human.arrayBuffer())).toEqual(PIXEL_GIF);
    await call(app, pixel as string, {
      headers: { "user-agent": "Mozilla/5.0" },
      cf: { asn: APPLE_ASN },
    });
    expect(deps.events.map(({ event }) => event.source === "tracking" && event.machine)).toEqual([
      false,
      true,
    ]);
    expect(deps.events[0]?.workspaceId).toBe(sent.seeded.workspaceId);
  });

  it("redirects a click to the stored URL and never to a URL from the request", async () => {
    const sent = await sentCampaign();
    const deps = await recordingDeps(sent.db);
    const app = mount("/t", createTrackingRoutes({ deps: () => deps }));
    const token = sent.tokens[0] as string;
    const click = await call(app, `/t/c/${token}/0`, { headers: { "user-agent": BROWSER } });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe("https://example.com/course");
    // An index the campaign does not have, or extra parts, go to the generic page.
    for (const path of [
      `/t/c/${token}/7`,
      `/t/c/${token}/-1`,
      `/t/c/${token}/https:%2F%2Fevil.example`,
    ]) {
      const response = await call(app, path);
      expect([302, 404]).toContain(response.status);
      if (response.status === 302) expect(response.headers.get("location")).toBe("/t/invalid");
    }
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0]?.event).toMatchObject({
      type: "click",
      bot: false,
      linkId: expect.any(Number),
    });
  });

  it("returns the image or a safe redirect for a forged token, and records no event", async () => {
    const sent = await sentCampaign();
    const deps = await recordingDeps(sent.db);
    const app = mount("/t", createTrackingRoutes({ deps: () => deps }));
    const token = sent.tokens[0] as string;
    const forged = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    const pixel = await call(app, `/t/o/${forged}`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get("content-type")).toBe("image/gif");
    const click = await call(app, `/t/c/${forged}/0`);
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe("/t/invalid");
    const honeypot = await call(app, `/t/h/${forged}`);
    expect(honeypot.status).toBe(204);
    expect(deps.events).toEqual([]);
    const page = await call(app, "/t/invalid");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("This link is not valid");
  });

  it("counts a HEAD request and a honeypot click as bot clicks, excluded from reports", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const deps = await recordingDeps(sent.db);
    const app = mount("/t", createTrackingRoutes({ deps: () => deps }));
    const [first, second] = sent.tokens as [string, string];
    const head = await call(app, `/t/c/${first}/0`, { method: "HEAD" });
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://example.com/course");
    const honeypot = sent.emails[0]?.html.match(/https:\/\/envelopen\.test(\/t\/h\/[^"]+)"/)?.[1];
    expect(honeypot).toBeDefined();
    await call(app, pathOf(`https://envelopen.test${honeypot}`));
    deps.clock.now += 60_000;
    await call(app, `/t/c/${second}/0`, { headers: { "user-agent": BROWSER } });
    expect(deps.events.map(({ event }) => event.source === "tracking" && event.bot)).toEqual([
      true,
      true,
      false,
    ]);

    const db = campaignDb();
    await flushEvents(
      db,
      workspaceId,
      deps.events.map(({ event }) => event),
      LATER,
    );
    const daily = await db.db
      .selectFrom("campaign_stats_daily")
      .select(["clicks", "unique_clicks", "bot_clicks"])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", sent.campaignId)
      .executeTakeFirstOrThrow();
    expect(daily).toEqual({ clicks: 1, unique_clicks: 1, bot_clicks: 2 });
    const stored = await db.db
      .selectFrom("email_events")
      .select(["is_bot"])
      .where("workspace_id", "=", workspaceId)
      .where("type", "=", "click")
      .orderBy("id")
      .execute();
    // Flagged events are stored, so they can be inspected later.
    expect(stored.map((row) => row.is_bot)).toEqual([1, 1, 0]);
  });
});

describe("tracking switches (R45)", () => {
  async function sentHtml(off: { workspace?: boolean; campaignOpens?: boolean }) {
    const sending = await sendingCampaign({ provider: "resend", contacts: 1 });
    const { workspaceId } = sending.seeded;
    if (off.workspace) {
      await sending.db.db
        .updateTable("workspaces")
        .set({ tracking_opens: 0, tracking_clicks: 0 })
        .where("id", "=", workspaceId)
        .execute();
    }
    if (off.campaignOpens) {
      await sending.db.db
        .updateTable("campaigns")
        .set({ tracking_opens: 0 })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", sending.campaignId)
        .execute();
    }
    const deps = await testDeps(sending.db);
    await processPointer(deps, sending.pointers[0]);
    const [email] = JSON.parse(deps.mock.calls[0]?.body ?? "[]") as { html: string }[];
    return email?.html ?? "";
  }

  it("sends no pixel and rewrites no links with tracking off for the workspace", async () => {
    const html = await sentHtml({ workspace: true });
    expect(html).not.toContain("/t/o/");
    expect(html).not.toContain("/t/c/");
    expect(html).not.toContain("/t/h/");
    expect(html).toContain('href="https://example.com/course"');
    // The unsubscribe link stays.
    expect(html).toContain("https://envelopen.test/u/");
  });

  it("follows the campaign's own switch when the workspace tracks", async () => {
    const html = await sentHtml({ campaignOpens: true });
    expect(html).not.toContain("/t/o/");
    expect(html).toContain("/t/c/");
  });
});
