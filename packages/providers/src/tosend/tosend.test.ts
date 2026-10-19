import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { toSendFixtures as f } from "../../conformance/fixtures/tosend";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { toSendAdapter, toSendSignature } from "./index";

function context(exchanges: RecordedExchange[], refs: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs } };
}

function hook(body: string, signature?: string) {
  return {
    url: "https://envelopen.test/hooks/tosend/1/2",
    method: "POST",
    headers: new Headers(signature ? { "x-tosend-signature": signature } : {}),
    body,
  };
}

describe("toSend adapter", () => {
  it("is transactional-only, with a warning to accept", () => {
    expect(toSendAdapter.policy).toBe("transactional-only");
    expect(toSendAdapter.policyWarning).toBeTruthy();
  });

  it("maps a 207 batch to each recipient", async () => {
    const { mock, ctx } = context([f.batchPartial]);
    const result = await sendBatch(toSendAdapter, campaignBatch(3), f.credentials, ctx);
    expect(result.results.map((item) => [item.outcome, item.reason ?? null])).toEqual([
      ["sent", null],
      ["not_sent", "validation"],
      ["not_sent", "rejected"],
    ]);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}");
    expect(body.emails[0]).toMatchObject({
      from: { email: "news@mail.example.com", name: "Course Academy" },
      to: [{ email: "student1@example.org" }],
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  });

  it("pauses on missing credits", async () => {
    const result = await sendBatch(
      toSendAdapter,
      campaignBatch(2),
      f.credentials,
      context([f.batchNoCredits]).ctx,
    );
    expect(result.failure).toMatchObject({ outcome: "not_sent", reason: "credits" });
  });

  it("connects, and rejects a wrong key", async () => {
    expect(await toSendAdapter.connect(f.credentials, context([f.info]).ctx)).toMatchObject({
      ok: true,
      refs: { admin: "false" },
    });
    expect(
      await toSendAdapter.connect(f.credentials, context([f.infoUnauthorized]).ctx),
    ).toMatchObject({
      ok: false,
      reason: "auth",
    });
  });

  it("creates the webhook only with an admin key", async () => {
    const target = { url: "https://envelopen.test/hooks/tosend/1/2", secret: "s" };
    expect(
      await toSendAdapter.setupEvents?.(f.credentials, target, context([], { admin: "false" }).ctx),
    ).toMatchObject({
      mode: "manual",
    });
    expect(
      await toSendAdapter.setupEvents?.(
        f.adminCredentials,
        target,
        context([f.webhookCreated], { admin: "true" }).ctx,
      ),
    ).toEqual({ mode: "auto", secret: "tosend-secret-1", refs: { webhookId: "wh_1" } });
  });

  it("verifies the HMAC of the raw body", async () => {
    const ctx = context([]).ctx;
    const signature = await toSendSignature("tosend-secret-1", f.events.bounced);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      await toSendAdapter.verifyWebhook(hook(f.events.bounced, signature), "tosend-secret-1", ctx),
    ).toEqual({ ok: true });
    expect(
      (
        await toSendAdapter.verifyWebhook(
          hook(`${f.events.bounced} `, signature),
          "tosend-secret-1",
          ctx,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await toSendAdapter.verifyWebhook(hook(f.events.bounced), "tosend-secret-1", ctx)).ok,
    ).toBe(false);
    expect(
      (await toSendAdapter.verifyWebhook(hook(f.events.bounced, signature), "other", ctx)).ok,
    ).toBe(false);
  });

  it("normalizes bounces and complaints with stable event ids", () => {
    const bounce = toSendAdapter.parseEvents(hook(f.events.bounced)).events;
    expect(bounce).toEqual([
      {
        type: "bounce_hard",
        eventId: "bounced:0100019a-tosend-1:student1@example.org",
        providerMessageId: "0100019a-tosend-1",
        email: "student1@example.org",
        occurredAt: Date.parse("2026-10-19T12:00:00Z"),
        detail: "General",
      },
    ]);
    // A replay parses to the same id, so it is stored once.
    expect(toSendAdapter.parseEvents(hook(f.events.bounced)).events[0]?.eventId).toBe(
      bounce[0]?.eventId,
    );
    expect(toSendAdapter.parseEvents(hook(f.events.complaint)).events[0]?.type).toBe("complaint");
  });
});
