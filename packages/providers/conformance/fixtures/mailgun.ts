import { mailgunSignature } from "../../src/mailgun/webhooks";
import type { WebhookRequest } from "../../src/types";
import type { CapturedRequest, RecordedExchange } from "../mock-fetch";
import type { ConformanceFixtures } from "./types";

// Mailgun exchanges, in the shapes of https://documentation.mailgun.com (checked
// 2026-10-22). Keys, tokens, and ids are made up.

export const MAILGUN_US = "https://api.mailgun.net";
export const MAILGUN_EU = "https://api.eu.mailgun.net";
const DOMAIN = "mail.example.com";
/** The clock of the fixtures: 2026-10-21 12:00 UTC. */
export const MAILGUN_NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const SIGNING_KEY = "mg-signing-key-0123456789abcdef";

const messagesUrl = (base: string) => `${base}/v3/${DOMAIN}/messages`;

/** A 200 answer of the messages endpoint, with an id per recipient. */
function queued(request: CapturedRequest) {
  const to = new URLSearchParams(request.body).get("to") ?? "unknown";
  return {
    status: 200,
    body: {
      id: `<20261021120000.${to.replace(/[^a-z0-9]/gi, "")}@${DOMAIN}>`,
      message: "Queued. Thank you.",
    },
  };
}

export const mailgunFixtures = {
  domain: DOMAIN,
  signingKey: SIGNING_KEY,
  now: MAILGUN_NOW,
  credentials: {
    apiKey: "test-mailgun-api-key-not-real",
    domain: DOMAIN,
    region: "us",
    webhookSigningKey: SIGNING_KEY,
  },
  domainOk: (base = MAILGUN_US, state = "active", type = "custom"): RecordedExchange => ({
    label: "GET /v3/domains/{domain}",
    method: "GET",
    url: `${base}/v3/domains/${DOMAIN}`,
    response: {
      status: 200,
      body: {
        domain: { name: DOMAIN, state, type, created_at: "Mon, 19 Oct 2026 12:00:00 GMT" },
        receiving_dns_records: [],
        sending_dns_records: [],
      },
    },
  }),
  domainBadKey: (base = MAILGUN_US): RecordedExchange => ({
    label: "GET /v3/domains/{domain} with a wrong key",
    method: "GET",
    url: `${base}/v3/domains/${DOMAIN}`,
    response: { status: 401, headers: { "content-type": "text/plain" }, body: "Forbidden" },
  }),
  domainMissing: (base = MAILGUN_US): RecordedExchange => ({
    label: "GET /v3/domains/{domain} for a domain of another region",
    method: "GET",
    url: `${base}/v3/domains/${DOMAIN}`,
    response: { status: 404, body: { message: "Domain not found" } },
  }),
  sendOk: (base = MAILGUN_US): RecordedExchange => ({
    label: "POST /v3/{domain}/messages, queued",
    method: "POST",
    url: messagesUrl(base),
    response: queued,
  }),
  rateLimited: (base = MAILGUN_US): RecordedExchange => ({
    label: "429 rate limit",
    method: "POST",
    url: messagesUrl(base),
    response: {
      status: 429,
      headers: {
        "x-ratelimit-limit": "300",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(MAILGUN_NOW + 4000),
      },
      body: { message: "Too many requests" },
    },
  }),
  unauthorized: (base = MAILGUN_US): RecordedExchange => ({
    label: "401 wrong key",
    method: "POST",
    url: messagesUrl(base),
    response: { status: 401, headers: { "content-type": "text/plain" }, body: "Forbidden" },
  }),
  quota: (base = MAILGUN_US): RecordedExchange => ({
    label: "403 sending limit",
    method: "POST",
    url: messagesUrl(base),
    response: {
      status: 403,
      body: {
        message:
          "Domain mail.example.com is not allowed to send: Daily limit of 100 messages reached for the Free plan",
      },
    },
  }),
  webhookCreated: (base = MAILGUN_US): RecordedExchange => ({
    label: "POST /v4/domains/{domain}/webhooks",
    method: "POST",
    url: `${base}/v4/domains/${DOMAIN}/webhooks`,
    response: {
      status: 200,
      body: {
        webhooks: {
          delivered: { urls: ["https://envelopen.test/hooks/mailgun/1/2"] },
          permanent_fail: { urls: ["https://envelopen.test/hooks/mailgun/1/2"] },
          temporary_fail: { urls: ["https://envelopen.test/hooks/mailgun/1/2"] },
          complained: { urls: ["https://envelopen.test/hooks/mailgun/1/2"] },
          unsubscribed: { urls: ["https://envelopen.test/hooks/mailgun/1/2"] },
        },
      },
    },
  }),
  webhookDeleted: (): RecordedExchange => ({
    label: "DELETE /v4/domains/{domain}/webhooks?url=",
    method: "DELETE",
    url: /^https:\/\/api(\.eu)?\.mailgun\.net\/v4\/domains\/mail\.example\.com\/webhooks\?url=/,
    response: { status: 200, body: { webhooks: {} } },
  }),
};

/** The `event-data` of a Mailgun event. */
export function mailgunEventData(
  event: string,
  extra: Record<string, unknown> = {},
  recipient = "student1@example.org",
) {
  return {
    id: `ev-${event}-${String(extra.severity ?? "x")}-${recipient.split("@")[0]}`,
    event,
    timestamp: MAILGUN_NOW / 1000 - 30 + 0.123456,
    recipient,
    "log-level": event === "failed" ? "error" : "info",
    message: {
      headers: {
        to: recipient,
        "message-id": `20261021120000.${recipient.replace(/[^a-z0-9]/gi, "")}@${DOMAIN}`,
        from: "news@mail.example.com",
        subject: "A new course starts Monday",
      },
    },
    "user-variables": {},
    ...extra,
  };
}

/** A signed Mailgun webhook request, as Mailgun posts it. */
export async function mailgunHook(
  eventData: Record<string, unknown>,
  options: { key?: string; token?: string; timestampMs?: number } = {},
): Promise<WebhookRequest> {
  const timestamp = String(Math.floor((options.timestampMs ?? MAILGUN_NOW) / 1000));
  const token = options.token ?? `tok${String(eventData.id ?? "x").replace(/[^A-Za-z0-9]/g, "")}`;
  const signature = await mailgunSignature(options.key ?? SIGNING_KEY, timestamp, token);
  return {
    url: "https://envelopen.test/hooks/mailgun/1/2",
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ signature: { timestamp, token, signature }, "event-data": eventData }),
  };
}

const permanent = () =>
  mailgunEventData("failed", {
    severity: "permanent",
    reason: "bounce",
    "delivery-status": { code: 550, message: "5.1.1 The email account does not exist." },
  });

/** The conformance fixtures of the Mailgun adapter (U18). */
export const mailgunConformance: ConformanceFixtures = {
  credentials: mailgunFixtures.credentials,
  refs: { region: "us", domain: DOMAIN },
  now: MAILGUN_NOW,
  emailHeaders: (request) => {
    const form = new URLSearchParams(request.body);
    const headers: Record<string, string> = {};
    for (const [name, value] of form) {
      if (name.startsWith("h:")) headers[name.slice(2)] = value;
    }
    return [headers];
  },
  send: {
    allSent: { exchanges: [mailgunFixtures.sendOk()] },
    partial: {
      size: 3,
      exchanges: [
        {
          label: "the second recipient is not a valid address for Mailgun",
          method: "POST",
          url: messagesUrl(MAILGUN_US),
          response: (request) =>
            new URLSearchParams(request.body).get("to") === "student2@example.org"
              ? { status: 400, body: { message: "to parameter is not a valid address." } }
              : queued(request),
        },
      ],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "validation" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      exchanges: [mailgunFixtures.rateLimited()],
      reason: "rate_limited",
      retryAfterMs: 4000,
    },
    permanent: { exchanges: [mailgunFixtures.unauthorized()], reason: "auth" },
    uncertain: {
      exchanges: [
        {
          label: "500 server error",
          method: "POST",
          url: messagesUrl(MAILGUN_US),
          response: { status: 500, body: { message: "Internal Server Error" } },
        },
      ],
    },
  },
  connect: {
    ok: [mailgunFixtures.domainOk()],
    badKey: [mailgunFixtures.domainBadKey()],
  },
  webhook: {
    secret: SIGNING_KEY,
    valid: () => mailgunHook(permanent()),
    stale: () => mailgunHook(permanent(), { timestampMs: MAILGUN_NOW - 6 * 60 * 1000 }),
  },
  events: [
    {
      label: "delivered",
      request: () => mailgunHook(mailgunEventData("delivered")),
      expected: [
        {
          type: "delivered",
          email: "student1@example.org",
          providerMessageId: "20261021120000.student1exampleorg@mail.example.com",
        },
      ],
    },
    {
      label: "permanent failure",
      request: () => mailgunHook(permanent()),
      expected: [{ type: "bounce_hard", email: "student1@example.org" }],
    },
    {
      label: "temporary failure",
      request: () =>
        mailgunHook(
          mailgunEventData(
            "failed",
            { severity: "temporary", reason: "generic" },
            "student3@example.org",
          ),
        ),
      expected: [{ type: "bounce_soft", email: "student3@example.org" }],
    },
    {
      label: "complaint",
      request: () => mailgunHook(mailgunEventData("complained")),
      expected: [{ type: "complaint", email: "student1@example.org" }],
    },
    {
      label: "open, which Envelopen tracks itself",
      request: () => mailgunHook(mailgunEventData("opened")),
      expected: [],
    },
  ],
  skip: {
    "webhook.changed":
      "Mailgun signs the timestamp and the token, not the event data. Envelopen accepts each token once (webhook_nonces), so a captured signature cannot carry a changed body.",
  },
};
