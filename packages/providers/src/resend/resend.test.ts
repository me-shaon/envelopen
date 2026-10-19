import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { resendFixtures as f } from "../../conformance/fixtures/resend";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { resendAdapter } from "./index";

function ctx(exchanges: RecordedExchange[], refs: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs } };
}

describe("Resend adapter", () => {
  it("sends a batch with the idempotency key, the headers, and permissive validation", async () => {
    const { mock, ctx: context } = ctx([f.batchAllSent]);
    const messages = campaignBatch(2);
    const result = await sendBatch(resendAdapter, messages, f.credentials, {
      ...context,
      idempotencyKey: "batch-7-key",
    });
    expect(result).toEqual({
      results: [
        {
          recipientId: "r1",
          outcome: "sent",
          providerMessageId: "ae2014de-c168-4c61-8267-70d2662a1ce1",
        },
        {
          recipientId: "r2",
          outcome: "sent",
          providerMessageId: "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb",
        },
      ],
    });
    const call = mock.calls[0];
    expect(call?.headers.get("idempotency-key")).toBe("batch-7-key");
    expect(call?.headers.get("x-batch-validation")).toBe("permissive");
    expect(call?.headers.get("authorization")).toBe("Bearer re_test_0123456789");
    const body = JSON.parse(call?.body ?? "[]");
    expect(body[0]).toMatchObject({
      from: "Course Academy <news@mail.example.com>",
      to: ["student1@example.org"],
      reply_to: "hello@example.com",
      headers: {
        "List-Unsubscribe": "<https://track.example.com/u/token1>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  });

  it("builds a byte-identical payload for a retry with the same key", async () => {
    const { mock, ctx: context } = ctx([f.batchAllSent]);
    const messages = campaignBatch(2);
    await sendBatch(resendAdapter, messages, f.credentials, { ...context, idempotencyKey: "k" });
    await sendBatch(resendAdapter, messages, f.credentials, { ...context, idempotencyKey: "k" });
    expect(mock.calls[0]?.body).toBe(mock.calls[1]?.body);
  });

  it("maps a partial failure to each recipient", async () => {
    const { ctx: context } = ctx([f.batchPartial]);
    const result = await sendBatch(resendAdapter, campaignBatch(3), f.credentials, context);
    expect(
      result.results.map((item) => [item.recipientId, item.outcome, item.providerMessageId]),
    ).toEqual([
      ["r1", "sent", "ae2014de-c168-4c61-8267-70d2662a1ce1"],
      ["r2", "not_sent", undefined],
      ["r3", "sent", "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb"],
    ]);
    expect(result.failure).toBeUndefined();
  });

  it("classifies rate limits, quotas, 5xx, and timeouts", async () => {
    const run = async (exchange: RecordedExchange) =>
      sendBatch(resendAdapter, campaignBatch(2), f.credentials, ctx([exchange]).ctx);
    expect((await run(f.batchRateLimited)).failure).toMatchObject({
      outcome: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 2000,
    });
    expect((await run(f.batchDailyQuota)).failure).toMatchObject({
      outcome: "not_sent",
      reason: "quota",
    });
    const server = await run(f.batchServerError);
    expect(server.failure).toMatchObject({ outcome: "unknown", reason: "server_error" });
    expect(server.results.every((item) => item.outcome === "unknown")).toBe(true);
    const timeout = await run({
      label: "timeout",
      method: "POST",
      url: "https://api.resend.com/emails/batch",
      response: "timeout",
    });
    expect(timeout.failure).toMatchObject({ outcome: "unknown", reason: "timeout" });
  });

  it("connects a full access key and a sending-only key, and rejects a wrong key", async () => {
    expect(await resendAdapter.connect(f.credentials, ctx([f.domainsOk]).ctx)).toMatchObject({
      ok: true,
      refs: { access: "full" },
    });
    const restricted = await resendAdapter.connect(f.credentials, ctx([f.domainsRestricted]).ctx);
    expect(restricted).toMatchObject({ ok: true, refs: { access: "sending" } });
    expect(restricted.ok && restricted.warnings[0]).toContain("can only send");
    expect(
      await resendAdapter.connect(f.credentials, ctx([f.domainsInvalidKey]).ctx),
    ).toMatchObject({
      ok: false,
      reason: "validation",
    });
    expect(
      await resendAdapter.connect(
        f.credentials,
        ctx([{ ...f.domainsOk, response: { status: 401, body: { name: "invalid_api_key" } } }]).ctx,
      ),
    ).toMatchObject({ ok: false, reason: "auth", message: "Resend rejected the API key." });
  });

  it("creates the webhook and returns its signing secret", async () => {
    const { mock, ctx: context } = ctx([f.webhookCreated], { access: "full" });
    const setup = await resendAdapter.setupEvents?.(
      f.credentials,
      { url: "https://envelopen.test/hooks/resend/1/2", secret: "ignored" },
      context,
    );
    expect(setup).toEqual({
      mode: "auto",
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      refs: { webhookId: "4dd369bc-aa82-4ff3-97de-514ae3000ee0" },
    });
    expect(JSON.parse(mock.calls[0]?.body ?? "{}")).toEqual({
      endpoint: "https://envelopen.test/hooks/resend/1/2",
      events: ["email.delivered", "email.bounced", "email.complained", "email.failed"],
    });
  });

  it("falls back to manual steps for a sending-only key or a failed create", async () => {
    const target = { url: "https://envelopen.test/hooks/resend/1/2", secret: "s" };
    expect(
      await resendAdapter.setupEvents?.(f.credentials, target, ctx([], { access: "sending" }).ctx),
    ).toMatchObject({
      mode: "manual",
    });
    const failed = ctx(
      [{ ...f.webhookCreated, response: { status: 500, body: { message: "Oops" } } }],
      { access: "full" },
    );
    expect(await resendAdapter.setupEvents?.(f.credentials, target, failed.ctx)).toMatchObject({
      mode: "manual",
    });
    expect(resendAdapter.manualSteps(target).join(" ")).toContain(target.url);
  });

  it("reads the DNS records of a domain", async () => {
    const records = await resendAdapter.domainRecords?.(
      f.credentials,
      "mail.example.com",
      ctx([f.domainsOk, f.domainDetail]).ctx,
    );
    expect(records).toEqual([
      {
        purpose: "return_path",
        type: "MX",
        host: "send.mail.example.com",
        value: "feedback-smtp.us-east-1.amazonses.com",
      },
      {
        purpose: "spf",
        type: "TXT",
        host: "send.mail.example.com",
        value: "v=spf1 include:amazonses.com ~all",
      },
      {
        purpose: "dkim",
        type: "TXT",
        host: "resend._domainkey.mail.example.com",
        value: "p=MIGfMA0GCSq",
      },
    ]);
  });

  it("normalizes events and skips opens", () => {
    const parse = (body: string) =>
      resendAdapter.parseEvents({
        url: "",
        method: "POST",
        headers: new Headers({ "svix-id": "msg_9" }),
        body,
      }).events;
    expect(parse(f.events.delivered)[0]).toMatchObject({
      type: "delivered",
      eventId: "msg_9:student1@example.org",
    });
    expect(parse(f.events.complained)[0]).toMatchObject({ type: "complaint" });
    expect(parse(f.events.opened)).toEqual([]);
    expect(parse("not json")).toEqual([]);
  });
});
