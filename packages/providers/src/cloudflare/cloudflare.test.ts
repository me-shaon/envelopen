import { describe, expect, it } from "vitest";
import { cloudflareFixtures as f } from "../../conformance/fixtures/cloudflare";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { cloudflareAdapter } from "./index";

function context(exchanges: RecordedExchange[]) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs: {} } };
}

describe("Cloudflare Email Sending adapter", () => {
  it("is transactional-only and needs Workers Paid", () => {
    expect(cloudflareAdapter.policy).toBe("transactional-only");
    expect(cloudflareAdapter.policyWarning).toContain("transactional email only");
    expect(cloudflareAdapter.facts.requiresWorkersPaid).toBe(true);
    expect(cloudflareAdapter.capabilities.autoWebhook).toBe(false);
  });

  it("sends one message per call, with the unsubscribe headers", async () => {
    const { mock, ctx } = context([f.sendOk, f.sendOk]);
    const result = await sendBatch(cloudflareAdapter, campaignBatch(2), f.credentials, ctx);
    expect(result.results.map((item) => item.outcome)).toEqual(["sent", "sent"]);
    expect(mock.calls).toHaveLength(2);
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").headers).toEqual({
      "List-Unsubscribe": expect.stringMatching(/^<https:/),
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("stops on a throttle or a missing Workers Paid plan", async () => {
    const throttled = await sendBatch(
      cloudflareAdapter,
      campaignBatch(1),
      f.credentials,
      context([f.sendThrottled]).ctx,
    );
    expect(throttled.failure).toMatchObject({ reason: "rate_limited" });
    const paid = await sendBatch(
      cloudflareAdapter,
      campaignBatch(3),
      f.credentials,
      context([f.sendNotEntitled]).ctx,
    );
    expect(paid.failure).toMatchObject({ outcome: "not_sent", reason: "auth" });
    expect(paid.results.every((item) => item.outcome === "not_sent")).toBe(true);
  });

  it("checks the token, and has no webhook", async () => {
    expect(
      await cloudflareAdapter.connect(f.credentials, context([f.verifyAccountToken]).ctx),
    ).toMatchObject({ ok: true });
    expect(
      await cloudflareAdapter.connect(
        f.credentials,
        context([f.verifyAccountTokenFails, f.verifyUserTokenFails]).ctx,
      ),
    ).toMatchObject({ ok: false, reason: "auth" });
    const request = {
      url: "https://e.test/hooks/cloudflare/1/2",
      method: "POST",
      headers: new Headers(),
      body: "{}",
    };
    expect((await cloudflareAdapter.verifyWebhook(request, "x", context([]).ctx)).ok).toBe(false);
  });
});
