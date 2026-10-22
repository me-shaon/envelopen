import { describe, expect, it } from "vitest";
import {
  mailgunFixtures as f,
  MAILGUN_EU,
  MAILGUN_NOW,
  MAILGUN_US,
  mailgunEventData,
  mailgunHook,
} from "../../conformance/fixtures/mailgun";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { classifyMailgunError, mailgunAdapter, mailgunRetryAfterMs } from "./index";
import { parseMailgunEvents, verifyMailgunWebhook } from "./webhooks";

const EU = { ...f.credentials, region: "eu" };

function context(exchanges: RecordedExchange[], refs: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs, now: () => MAILGUN_NOW } };
}

describe("Mailgun adapter", () => {
  it("sends one form post per recipient with both unsubscribe headers as h: fields", async () => {
    const { mock, ctx } = context([f.sendOk()]);
    const result = await sendBatch(mailgunAdapter, campaignBatch(3), f.credentials, ctx);
    expect(result.failure).toBeUndefined();
    expect(result.results.map((item) => item.providerMessageId)).toEqual([
      "20261021120000.student1exampleorg@mail.example.com",
      "20261021120000.student2exampleorg@mail.example.com",
      "20261021120000.student3exampleorg@mail.example.com",
    ]);
    expect(mock.calls).toHaveLength(3);
    const call = mock.calls.find(
      (item) => new URLSearchParams(item.body).get("to") === "student1@example.org",
    );
    expect(call?.url).toBe(`${MAILGUN_US}/v3/mail.example.com/messages`);
    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(`api:${f.credentials.apiKey}`)}`);
    const form = new URLSearchParams(call?.body);
    expect(form.get("h:List-Unsubscribe")).toBe("<https://track.example.com/u/token1>");
    expect(form.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(form.get("h:Reply-To")).toBe("hello@example.com");
    expect(form.get("html")).toBe("<p>Hello student 1</p>");
    expect(form.get("o:tracking")).toBe("no");
  });

  it("sends to the EU base URL for an EU connection", async () => {
    const { mock, ctx } = context([f.sendOk(MAILGUN_EU)], { region: "eu" });
    const result = await sendBatch(mailgunAdapter, campaignBatch(2), EU, ctx);
    expect(result.results.every((item) => item.outcome === "sent")).toBe(true);
    expect(mock.calls.map((call) => new URL(call.url).host)).toEqual([
      "api.eu.mailgun.net",
      "api.eu.mailgun.net",
    ]);
  });

  it("connects to the region's API, and keeps the region and the domain", async () => {
    const { mock, ctx } = context([f.domainOk(MAILGUN_EU)]);
    const check = await mailgunAdapter.connect(EU, ctx);
    expect(check).toEqual({
      ok: true,
      account: "mail.example.com, EU region",
      warnings: [],
      refs: { region: "eu", domain: "mail.example.com" },
    });
    expect(mock.calls[0]?.url).toBe(`${MAILGUN_EU}/v3/domains/mail.example.com`);
  });

  it("maps a 401 on connect to auth, and a missing domain to validation", async () => {
    const bad = await mailgunAdapter.connect(f.credentials, context([f.domainBadKey()]).ctx);
    expect(bad).toMatchObject({ ok: false, reason: "auth" });
    const missing = await mailgunAdapter.connect(f.credentials, context([f.domainMissing()]).ctx);
    expect(missing).toMatchObject({ ok: false, reason: "validation" });
  });

  it("warns about a sandbox domain and a domain that is not verified", async () => {
    const check = await mailgunAdapter.connect(
      f.credentials,
      context([f.domainOk(MAILGUN_US, "unverified", "sandbox")]).ctx,
    );
    expect(check.ok && check.warnings).toHaveLength(2);
  });

  it("maps a 401 on send to auth and stops the batch", async () => {
    const { mock, ctx } = context([f.unauthorized()]);
    const result = await sendBatch(mailgunAdapter, campaignBatch(10), f.credentials, ctx);
    expect(result.failure).toMatchObject({ outcome: "not_sent", reason: "auth", status: 401 });
    expect(result.results.every((item) => item.outcome === "not_sent")).toBe(true);
    // The pool has 5 workers, so at most 5 requests start before the stop.
    expect(mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("maps a 429 to rate_limited with retryAfterMs from the rate limit headers", async () => {
    const result = await sendBatch(
      mailgunAdapter,
      campaignBatch(2),
      f.credentials,
      context([f.rateLimited()]).ctx,
    );
    expect(result.failure).toMatchObject({ reason: "rate_limited", retryAfterMs: 4000 });
    const withRetryAfter = new Response(null, { status: 429, headers: { "retry-after": "7" } });
    expect(mailgunRetryAfterMs(withRetryAfter, MAILGUN_NOW)).toBe(7000);
    const inSeconds = new Response(null, {
      status: 429,
      headers: { "x-ratelimit-reset": String(MAILGUN_NOW / 1000 + 2) },
    });
    expect(mailgunRetryAfterMs(inSeconds, MAILGUN_NOW)).toBe(2000);
  });

  it("maps a sending limit to quota, and 403 and 5xx to their classes", async () => {
    const result = await sendBatch(
      mailgunAdapter,
      campaignBatch(2),
      f.credentials,
      context([f.quota()]).ctx,
    );
    expect(result.failure).toMatchObject({ reason: "quota" });
    expect(classifyMailgunError(403, "Forbidden").reason).toBe("auth");
    expect(classifyMailgunError(429, "Rate limit exceeded").reason).toBe("rate_limited");
    expect(classifyMailgunError(502)).toMatchObject({ outcome: "unknown", stop: false });
  });

  it("creates the webhook for five events and returns the signing key as the secret", async () => {
    const { mock, ctx } = context([f.webhookCreated(MAILGUN_EU)], { region: "eu" });
    const setup = await mailgunAdapter.setupEvents?.(
      EU,
      { url: "https://envelopen.test/hooks/mailgun/1/2", secret: "ignored" },
      ctx,
    );
    expect(setup).toEqual({
      mode: "auto",
      secret: f.signingKey,
      refs: { webhookUrl: "https://envelopen.test/hooks/mailgun/1/2" },
    });
    const form = new URLSearchParams(mock.calls[0]?.body);
    expect(form.getAll("event_types")).toEqual([
      "delivered",
      "permanent_fail",
      "temporary_fail",
      "complained",
      "unsubscribed",
    ]);
    expect(mock.calls[0]?.url).toBe(`${MAILGUN_EU}/v4/domains/mail.example.com/webhooks`);
  });

  it("removes only Envelopen's webhook URL", async () => {
    const { mock, ctx } = context([f.webhookDeleted()], {
      region: "us",
      webhookUrl: "https://envelopen.test/hooks/mailgun/1/2",
    });
    await mailgunAdapter.teardownEvents?.(f.credentials, ctx);
    expect(mock.calls[0]?.url).toBe(
      `${MAILGUN_US}/v4/domains/mail.example.com/webhooks?url=${encodeURIComponent("https://envelopen.test/hooks/mailgun/1/2")}`,
    );
  });
});

describe("Mailgun webhooks", () => {
  const data = () => mailgunEventData("delivered");

  it("accepts a fresh signature and returns the token as a nonce", async () => {
    const request = await mailgunHook(data(), { token: "tokenabc" });
    const result = await verifyMailgunWebhook(request, f.signingKey, MAILGUN_NOW);
    expect(result).toEqual({
      ok: true,
      nonce: { value: "tokenabc", expiresAt: MAILGUN_NOW + 5 * 60 * 1000 },
    });
  });

  it("rejects an old timestamp, a future one, and a wrong key", async () => {
    const old = await mailgunHook(data(), { timestampMs: MAILGUN_NOW - 5 * 60 * 1000 - 1000 });
    expect((await verifyMailgunWebhook(old, f.signingKey, MAILGUN_NOW)).ok).toBe(false);
    const future = await mailgunHook(data(), { timestampMs: MAILGUN_NOW + 6 * 60 * 1000 });
    expect((await verifyMailgunWebhook(future, f.signingKey, MAILGUN_NOW)).ok).toBe(false);
    const wrong = await mailgunHook(data(), { key: "another-key" });
    expect((await verifyMailgunWebhook(wrong, f.signingKey, MAILGUN_NOW)).ok).toBe(false);
    expect((await verifyMailgunWebhook(wrong, "", MAILGUN_NOW)).ok).toBe(false);
  });

  it("rejects a body without a signature", async () => {
    const request = await mailgunHook(data());
    const body = JSON.parse(request.body);
    delete body.signature;
    const result = await verifyMailgunWebhook(
      { ...request, body: JSON.stringify(body) },
      f.signingKey,
      MAILGUN_NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("maps failed events by severity and reason", async () => {
    const parse = async (extra: Record<string, unknown>) =>
      parseMailgunEvents(await mailgunHook(mailgunEventData("failed", extra)));
    expect((await parse({ severity: "permanent", reason: "bounce" })).events[0]?.type).toBe(
      "bounce_hard",
    );
    expect((await parse({ severity: "temporary", reason: "generic" })).events[0]?.type).toBe(
      "bounce_soft",
    );
    expect((await parse({ severity: "permanent", reason: "old" })).events[0]?.type).toBe(
      "bounce_soft",
    );
    expect(
      (await parse({ severity: "permanent", reason: "suppress-complaint" })).events[0]?.type,
    ).toBe("complaint");
    const dropped = await parse({ severity: "permanent", reason: "suppress-unsubscribe" });
    expect(dropped.events).toEqual([]);
    expect(dropped.unsubscribes).toHaveLength(1);
  });

  it("returns an unsubscribe as a provider unsubscribe, not an event", async () => {
    const parsed = parseMailgunEvents(await mailgunHook(mailgunEventData("unsubscribed")));
    expect(parsed.events).toEqual([]);
    expect(parsed.unsubscribes).toEqual([
      {
        eventId: expect.stringMatching(/^unsubscribed:/),
        email: "student1@example.org",
        providerMessageId: "20261021120000.student1exampleorg@mail.example.com",
        occurredAt: MAILGUN_NOW - 30_000 + 123,
      },
    ]);
  });
});
