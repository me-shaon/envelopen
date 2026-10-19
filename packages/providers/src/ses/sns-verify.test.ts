import { beforeEach, describe, expect, it } from "vitest";
import { sesFixtures, TOPIC_ARN } from "../../conformance/fixtures/ses";
import { mockFetch } from "../../conformance/mock-fetch";
import { createSnsSigner, type SnsSigner } from "../../conformance/sns-signer";
import type { WebhookRequest } from "../types";
import { sesAdapter } from "./index";
import { clearSnsKeyCache, isSnsUrl, type SnsMessage } from "./sns-verify";

const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem";
const SECRET = "url-token-0123456789";
const HOOK = `https://envelopen.test/hooks/ses/1/2?token=${SECRET}`;

let signer: SnsSigner;

beforeEach(async () => {
  clearSnsKeyCache();
  signer ??= await createSnsSigner();
});

function certFetch(pem = signer.certificatePem) {
  return mockFetch([
    {
      label: "signing certificate",
      method: "GET",
      url: /\.pem$/,
      response: { status: 200, body: pem },
    },
  ]);
}

function notification(overrides: Partial<SnsMessage> = {}): Omit<SnsMessage, "Signature"> {
  return {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC_ARN,
    Message: sesFixtures.bounceEvent,
    Timestamp: "2026-10-19T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    UnsubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe",
    ...overrides,
  };
}

function request(message: SnsMessage | Record<string, unknown>, url = HOOK): WebhookRequest {
  return {
    url,
    method: "POST",
    headers: new Headers({ "x-amz-sns-message-type": String(message.Type) }),
    body: JSON.stringify(message),
  };
}

async function verify(
  message: SnsMessage,
  options: { url?: string; refs?: Record<string, string> } = {},
) {
  const mock = certFetch();
  const result = await sesAdapter.verifyWebhook(request(message, options.url), SECRET, {
    fetch: mock.fetch,
    refs: options.refs ?? { region: "us-east-1", topicArn: TOPIC_ARN },
  });
  return { result, calls: mock.calls };
}

describe("SNS signature verification", () => {
  it("accepts a valid SignatureVersion 2 message", async () => {
    const message = await signer.sign(notification(), "2");
    const { result, calls } = await verify(message);
    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([CERT_URL]);
  });

  it("accepts a valid SignatureVersion 1 message", async () => {
    const message = await signer.sign(notification(), "1");
    expect((await verify(message)).result).toEqual({ ok: true });
  });

  it("accepts a message with a Subject, which is part of the signed string", async () => {
    const message = await signer.sign(notification({ Subject: "Amazon SES Email Event" }));
    expect((await verify(message)).result).toEqual({ ok: true });
    const changed = { ...message, Subject: "Something else" };
    expect((await verify(changed)).result.ok).toBe(false);
  });

  it("rejects a changed message", async () => {
    const message = await signer.sign(notification());
    const changed = { ...message, Message: sesFixtures.complaintEvent };
    expect((await verify(changed)).result).toMatchObject({
      ok: false,
      reason: "The signature does not match.",
    });
  });

  it("rejects a message signed by another key", async () => {
    const other = await createSnsSigner();
    const message = await other.sign(notification());
    expect((await verify(message)).result.ok).toBe(false);
  });

  it.each([
    ["another host", "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem"],
    ["another region", "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem"],
    ["plain HTTP", "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem"],
    ["a port", "https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-abc123.pem"],
    ["user info", "https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem"],
    ["not a PEM", "https://sns.us-east-1.amazonaws.com/cert.txt"],
    ["an S3 bucket", "https://s3.amazonaws.com/sns.us-east-1.amazonaws.com/cert.pem"],
  ])("rejects a certificate URL on %s without fetching it", async (_label, url) => {
    const message = await signer.sign(notification({ SigningCertURL: url }));
    const { result, calls } = await verify(message);
    expect(result).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("rejects a topic of another region or another account", async () => {
    const otherRegion = await signer.sign(
      notification({ TopicArn: "arn:aws:sns:eu-west-1:123456789012:envelopen-abc" }),
    );
    expect((await verify(otherRegion, { refs: { region: "us-east-1" } })).result.ok).toBe(false);
    const otherTopic = await signer.sign(
      notification({ TopicArn: "arn:aws:sns:us-east-1:999999999999:attacker" }),
    );
    expect((await verify(otherTopic)).result).toMatchObject({ ok: false });
  });

  it("rejects a request without the URL token, even with a valid signature", async () => {
    const message = await signer.sign(notification());
    const { result } = await verify(message, {
      url: "https://envelopen.test/hooks/ses/1/2?token=wrong",
    });
    expect(result).toEqual({ ok: false, reason: "Wrong token." });
    const missing = await verify(message, { url: "https://envelopen.test/hooks/ses/1/2" });
    expect(missing.result.ok).toBe(false);
  });

  it("rejects an unknown SignatureVersion and a body that is not SNS", async () => {
    const message = await signer.sign(notification());
    expect((await verify({ ...message, SignatureVersion: "3" })).result.ok).toBe(false);
    const mock = certFetch();
    const result = await sesAdapter.verifyWebhook(
      { url: HOOK, method: "POST", headers: new Headers(), body: "not json" },
      SECRET,
      { fetch: mock.fetch, refs: { region: "us-east-1" } },
    );
    expect(result.ok).toBe(false);
  });

  it("does not trust a certificate that fails to load", async () => {
    const message = await signer.sign(notification());
    const mock = mockFetch([
      { label: "cert 404", method: "GET", url: /\.pem$/, response: { status: 404 } },
    ]);
    const result = await sesAdapter.verifyWebhook(request(message), SECRET, {
      fetch: mock.fetch,
      refs: { region: "us-east-1" },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "The signing certificate could not be loaded.",
    });
  });

  it("checks SNS hosts strictly", () => {
    expect(isSnsUrl("https://sns.us-east-1.amazonaws.com/x.pem", "us-east-1", ".pem")).toBe(true);
    expect(isSnsUrl("https://sns.us-east-1.amazonaws.com/x.pem", "not a region", ".pem")).toBe(
      false,
    );
    expect(isSnsUrl("https://SNS.us-east-1.amazonaws.com/x.pem", "us-east-1", ".pem")).toBe(true);
    expect(isSnsUrl("javascript:alert(1)", "us-east-1")).toBe(false);
  });
});

describe("SNS subscription confirmation", () => {
  it("verifies the confirmation and returns the SubscribeURL to visit", async () => {
    const subscribeUrl =
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc";
    const message = await signer.sign({
      Type: "SubscriptionConfirmation",
      MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
      Token: "abc",
      TopicArn: TOPIC_ARN,
      Message: "You have chosen to subscribe to the topic.",
      SubscribeURL: subscribeUrl,
      Timestamp: "2026-10-19T12:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
    });
    expect((await verify(message)).result).toEqual({ ok: true });
    expect(sesAdapter.parseEvents(request(message))).toEqual({
      events: [],
      confirmSubscriptionUrl: subscribeUrl,
    });
    // A changed SubscribeURL breaks the signature.
    const changed = {
      ...message,
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=Other",
    };
    expect((await verify(changed)).result.ok).toBe(false);
  });

  it("never returns a SubscribeURL outside SNS", () => {
    const message = {
      Type: "SubscriptionConfirmation",
      MessageId: "1",
      TopicArn: TOPIC_ARN,
      Message: "x",
      Timestamp: "2026-10-19T12:00:00.000Z",
      Signature: "x",
      SigningCertURL: CERT_URL,
      SubscribeURL: "https://169.254.169.254/latest/meta-data/",
    };
    expect(sesAdapter.parseEvents(request(message)).confirmSubscriptionUrl).toBeUndefined();
  });
});

describe("SES event normalization", () => {
  it("maps bounces, complaints, and deliveries per recipient", async () => {
    const parse = async (body: string) =>
      sesAdapter.parseEvents(request(await signer.sign(notification({ Message: body })))).events;
    expect(await parse(sesFixtures.bounceEvent)).toEqual([
      {
        type: "bounce_hard",
        eventId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324:student1@example.org",
        providerMessageId: "0100018a-ses-message-id",
        email: "student1@example.org",
        occurredAt: Date.parse("2026-10-19T12:00:00.000Z"),
        detail: "General",
      },
    ]);
    expect((await parse(sesFixtures.complaintEvent))[0]).toMatchObject({
      type: "complaint",
      email: "student2@example.org",
    });
    expect((await parse(sesFixtures.deliveryEvent))[0]).toMatchObject({
      type: "delivered",
      email: "student3@example.org",
    });
    const transient = sesFixtures.bounceEvent.replace("Permanent", "Transient");
    expect((await parse(transient))[0]?.type).toBe("bounce_soft");
    expect(await parse(JSON.stringify({ eventType: "Open", mail: { messageId: "x" } }))).toEqual(
      [],
    );
  });
});
