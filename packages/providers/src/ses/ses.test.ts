import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { sesFixtures as f, TOPIC_ARN } from "../../conformance/fixtures/ses";
import { mockFetch, type RecordedExchange } from "../../conformance/mock-fetch";
import { sendBatch } from "../shared/messages";
import { sesAdapter } from "./index";

function context(exchanges: RecordedExchange[], refs: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  return { mock, ctx: { fetch: mock.fetch, refs } };
}

describe("SES adapter", () => {
  it("sends one signed SendEmail per recipient with the unsubscribe headers", async () => {
    const { mock, ctx } = context([f.sendOk("m1"), f.sendOk("m2")], {
      configurationSet: "envelopen-x",
    });
    const result = await sendBatch(sesAdapter, campaignBatch(2), f.credentials, ctx);
    expect(result.results.map((item) => item.outcome)).toEqual(["sent", "sent"]);
    expect(result.results.map((item) => item.providerMessageId).sort()).toEqual(["m1", "m2"]);
    const call = mock.calls[0];
    expect(call?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request/,
    );
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.ConfigurationSetName).toBe("envelopen-x");
    expect(body.Content.Simple.Headers).toEqual([
      {
        Name: "List-Unsubscribe",
        Value: expect.stringMatching(/^<https:\/\/track\.example\.com\/u\/token\d>$/),
      },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
    expect(body.Destination).toEqual({ ToAddresses: [expect.stringMatching(/@example\.org$/)] });
  });

  it("keeps a rejected recipient apart from the rest of the batch", async () => {
    const { ctx } = context([f.sendOk("m1"), f.sendRejected, f.sendOk("m3")]);
    const result = await sendBatch(sesAdapter, campaignBatch(3), f.credentials, { ...ctx });
    const outcomes = result.results.map((item) => item.outcome).sort();
    expect(outcomes).toEqual(["not_sent", "sent", "sent"]);
    expect(result.results.find((item) => item.outcome === "not_sent")?.reason).toBe("rejected");
    expect(result.failure).toBeUndefined();
  });

  it("stops after a throttle, so the rest is not sent and can retry", async () => {
    const { mock, ctx } = context([{ ...f.sendThrottled, times: 100 }]);
    const result = await sendBatch(sesAdapter, campaignBatch(12), f.credentials, ctx);
    expect(result.failure).toMatchObject({ outcome: "not_sent", reason: "rate_limited" });
    expect(result.results.every((item) => item.outcome === "not_sent")).toBe(true);
    // Only the requests already in flight reached SES.
    expect(mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("marks a 5xx or a timeout as unknown for that recipient only", async () => {
    const { ctx } = context([
      f.sendServerError,
      {
        label: "timeout",
        method: "POST",
        url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
        times: 1,
        response: "timeout",
      },
      f.sendOk("m3"),
    ]);
    const result = await sendBatch(sesAdapter, campaignBatch(3), f.credentials, ctx);
    expect(result.results.map((item) => item.outcome).sort()).toEqual([
      "sent",
      "unknown",
      "unknown",
    ]);
    expect(result.failure).toBeUndefined();
  });

  it("connects, reports the sandbox, and rejects a wrong key", async () => {
    expect(await sesAdapter.connect(f.credentials, context([f.accountProduction]).ctx)).toEqual({
      ok: true,
      account: "us-east-1, production access",
      warnings: [],
      refs: { region: "us-east-1", maxSendRate: "14", max24HourSend: "50000" },
    });
    const sandbox = await sesAdapter.connect(f.credentials, context([f.accountSandbox]).ctx);
    expect(sandbox.ok && sandbox.warnings[0]).toContain("sandbox");
    expect(
      await sesAdapter.connect(f.credentials, context([f.accountForbidden]).ctx),
    ).toMatchObject({
      ok: false,
      reason: "auth",
    });
    const down = context([{ ...f.accountProduction, response: "network" }]);
    expect(await sesAdapter.connect(f.credentials, down.ctx)).toMatchObject({
      ok: false,
      reason: "network",
    });
  });

  it("creates the configuration set, a SignatureVersion 2 topic, the subscription, and the destination", async () => {
    const actions: string[] = [];
    const { mock, ctx } = context([
      f.createConfigurationSet,
      f.sns((action) => {
        actions.push(action);
        if (action === "CreateTopic") return { status: 200, body: f.createTopicXml };
        if (action === "Subscribe") return { status: 200, body: f.subscribeXml };
        return { status: 200, body: "<SetTopicAttributesResponse/>" };
      }),
      f.createEventDestination,
    ]);
    const target = {
      url: "https://envelopen.test/hooks/ses/1/2?token=abc",
      secret: "abcDEF123456789xyz",
    };
    const setup = await sesAdapter.setupEvents?.(f.credentials, target, ctx);
    expect(setup).toEqual({
      mode: "auto",
      secret: target.secret,
      refs: { configurationSet: "envelopen-abcdef123456789x", topicArn: TOPIC_ARN },
    });
    expect(actions).toEqual(["CreateTopic", "SetTopicAttributes", "Subscribe"]);
    const attributes = new URLSearchParams(
      mock.calls.find((call) => call.body.includes("SetTopicAttributes"))?.body,
    );
    expect(attributes.get("AttributeName")).toBe("SignatureVersion");
    expect(attributes.get("AttributeValue")).toBe("2");
    const subscribe = new URLSearchParams(
      mock.calls.find((call) => call.body.includes("Action=Subscribe"))?.body,
    );
    expect(subscribe.get("Endpoint")).toBe(target.url);
    expect(subscribe.get("Protocol")).toBe("https");
  });

  it("falls back to manual steps when the IAM user lacks the permissions", async () => {
    const { ctx } = context([f.createConfigurationSetDenied]);
    const setup = await sesAdapter.setupEvents?.(
      f.credentials,
      { url: "https://e.test/h", secret: "s" },
      ctx,
    );
    expect(setup).toMatchObject({ mode: "manual" });
  });

  it("puts the secret in the webhook URL path, not in the query string", () => {
    expect(sesAdapter.webhookUrl?.("https://envelopen.test/hooks/ses/1/2", "s3cr3t")).toBe(
      "https://envelopen.test/hooks/ses/1/2/s3cr3t",
    );
  });

  it("lists the DKIM records of an identity", async () => {
    const records = await sesAdapter.domainRecords?.(
      f.credentials,
      "mail.example.com",
      context([f.identity]).ctx,
    );
    expect(records?.[0]).toEqual({
      purpose: "dkim",
      type: "CNAME",
      host: "tok1._domainkey.mail.example.com",
      value: "tok1.dkim.amazonses.com",
    });
  });
});
