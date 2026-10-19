import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { postmarkFixtures as f } from "../../conformance/fixtures/postmark";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { postmarkAdapter, postmarkAuthorization } from "./index";

function context(exchanges: RecordedExchange[], refs: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs } };
}

function hook(body: string, authorization?: string) {
  return {
    url: "https://envelopen.test/hooks/postmark/1/2",
    method: "POST",
    headers: new Headers(authorization ? { authorization } : {}),
    body,
  };
}

describe("Postmark adapter", () => {
  it("sends through the Broadcast stream and maps per-message errors", async () => {
    const { mock, ctx } = context([f.batchPartial], { messageStream: "broadcasts" });
    const result = await sendBatch(postmarkAdapter, campaignBatch(3), f.credentials, ctx);
    expect(result.results.map((item) => [item.outcome, item.reason])).toEqual([
      ["sent", undefined],
      ["not_sent", "rejected"],
      ["sent", undefined],
    ]);
    const body = JSON.parse(mock.calls[0]?.body ?? "[]");
    expect(body[0]).toMatchObject({
      MessageStream: "broadcasts",
      TrackOpens: false,
      Headers: [
        { Name: "List-Unsubscribe", Value: "<https://track.example.com/u/token1>" },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ],
    });
    expect(mock.calls[0]?.headers.get("x-postmark-server-token")).toBe(f.credentials.serverToken);
  });

  it("treats an account that is not approved as an account-level failure", async () => {
    const result = await sendBatch(
      postmarkAdapter,
      campaignBatch(2),
      f.credentials,
      context([f.batchNotApproved]).ctx,
    );
    expect(result.failure).toMatchObject({ outcome: "not_sent", reason: "auth" });
  });

  it("connects, finds the Broadcast stream, and warns when Postmark manages unsubscribes", async () => {
    const custom = await postmarkAdapter.connect(
      f.credentials,
      context([f.server, f.streams("Custom")]).ctx,
    );
    expect(custom).toEqual({
      ok: true,
      account: "Course Academy, stream broadcasts",
      warnings: [],
      refs: { messageStream: "broadcasts" },
    });
    const managed = await postmarkAdapter.connect(
      f.credentials,
      context([f.server, f.streams("Postmark")]).ctx,
    );
    expect(managed.ok && managed.warnings[0]).toContain("custom unsubscribe handling");
    expect(
      await postmarkAdapter.connect(f.credentials, context([f.server, f.noStreams]).ctx),
    ).toMatchObject({
      ok: false,
      reason: "validation",
    });
    expect(
      await postmarkAdapter.connect(f.credentials, context([f.serverBadToken]).ctx),
    ).toMatchObject({
      ok: false,
      reason: "auth",
    });
  });

  it("creates the webhook with Basic auth on the stream", async () => {
    const { mock, ctx } = context([f.webhookCreated], { messageStream: "broadcasts" });
    const setup = await postmarkAdapter.setupEvents?.(
      f.credentials,
      { url: "https://envelopen.test/hooks/postmark/1/2", secret: "pm-secret" },
      ctx,
    );
    expect(setup).toEqual({ mode: "auto", secret: "pm-secret", refs: { webhookId: "1234567" } });
    expect(JSON.parse(mock.calls[0]?.body ?? "{}")).toMatchObject({
      MessageStream: "broadcasts",
      HttpAuth: { Username: "envelopen", Password: "pm-secret" },
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true },
        SpamComplaint: { Enabled: true },
      },
    });
  });

  it("accepts only the Basic auth of the secret", async () => {
    const ctx = context([]).ctx;
    expect(
      await postmarkAdapter.verifyWebhook(
        hook("{}", postmarkAuthorization("pm-secret")),
        "pm-secret",
        ctx,
      ),
    ).toEqual({
      ok: true,
    });
    expect(
      (
        await postmarkAdapter.verifyWebhook(
          hook("{}", postmarkAuthorization("other")),
          "pm-secret",
          ctx,
        )
      ).ok,
    ).toBe(false);
    expect((await postmarkAdapter.verifyWebhook(hook("{}"), "pm-secret", ctx)).ok).toBe(false);
  });

  it("normalizes bounces, deliveries, and complaints, and skips auto-responders", () => {
    expect(postmarkAdapter.parseEvents(hook(f.events.hardBounce)).events[0]).toMatchObject({
      type: "bounce_hard",
      email: "student1@example.org",
      providerMessageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
    });
    expect(postmarkAdapter.parseEvents(hook(f.events.delivery)).events[0]).toMatchObject({
      type: "delivered",
    });
    expect(postmarkAdapter.parseEvents(hook(f.events.complaint)).events[0]).toMatchObject({
      type: "complaint",
    });
    expect(postmarkAdapter.parseEvents(hook(f.events.autoResponder)).events).toEqual([]);
  });
});
