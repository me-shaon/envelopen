import { svixSign } from "../../src/resend/svix-verify";
import type { ConformanceFixtures } from "./types";

// Resend exchanges, in the shapes of https://resend.com/docs/api-reference (checked
// 2026-10-19). Ids are made up.

const BATCH = "https://api.resend.com/emails/batch";

export const resendFixtures = {
  credentials: { apiKey: "re_test_0123456789" },
  webhookSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",

  batchAllSent: {
    label: "batch of two, both accepted",
    method: "POST",
    url: BATCH,
    response: {
      status: 200,
      body: {
        data: [
          { id: "ae2014de-c168-4c61-8267-70d2662a1ce1" },
          { id: "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb" },
        ],
      },
    },
  },
  batchPartial: {
    label: "permissive batch of three, the second is invalid",
    method: "POST",
    url: BATCH,
    response: {
      status: 200,
      body: {
        data: [
          { id: "ae2014de-c168-4c61-8267-70d2662a1ce1" },
          { id: "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb" },
        ],
        errors: [{ index: 1, message: "Invalid `to` field." }],
      },
    },
  },
  batchRateLimited: {
    label: "rate limit",
    method: "POST",
    url: BATCH,
    response: {
      status: 429,
      headers: { "retry-after": "2" },
      body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." },
    },
  },
  batchDailyQuota: {
    label: "daily quota",
    method: "POST",
    url: BATCH,
    response: {
      status: 429,
      body: { statusCode: 429, name: "daily_quota_exceeded", message: "Daily quota reached." },
    },
  },
  batchServerError: {
    label: "server error",
    method: "POST",
    url: BATCH,
    response: {
      status: 500,
      body: { statusCode: 500, name: "application_error", message: "Oops." },
    },
  },
  domainsOk: {
    label: "list domains with a full access key",
    method: "GET",
    url: "https://api.resend.com/domains",
    response: { status: 200, body: { data: [{ id: "d91cd9bd", name: "mail.example.com" }] } },
  },
  domainsRestricted: {
    label: "list domains with a sending-only key",
    method: "GET",
    url: "https://api.resend.com/domains",
    response: {
      status: 401,
      body: {
        statusCode: 401,
        name: "restricted_api_key",
        message: "This API key is restricted to only send emails.",
      },
    },
  },
  domainsInvalidKey: {
    label: "list domains with a wrong key",
    method: "GET",
    url: "https://api.resend.com/domains",
    response: {
      status: 400,
      body: { statusCode: 400, name: "validation_error", message: "API key is invalid" },
    },
  },
  domainDetail: {
    label: "domain records",
    method: "GET",
    url: "https://api.resend.com/domains/d91cd9bd",
    response: {
      status: 200,
      body: {
        id: "d91cd9bd",
        name: "mail.example.com",
        records: [
          {
            record: "SPF",
            name: "send",
            type: "MX",
            value: "feedback-smtp.us-east-1.amazonses.com",
          },
          { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all" },
          { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=MIGfMA0GCSq" },
        ],
      },
    },
  },
  webhookCreated: {
    label: "create webhook",
    method: "POST",
    url: "https://api.resend.com/webhooks",
    response: {
      status: 201,
      body: {
        object: "webhook",
        id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0",
        signing_secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      },
    },
  },
  webhookDeleted: {
    label: "delete webhook",
    method: "DELETE",
    url: /^https:\/\/api\.resend\.com\/webhooks\/.+$/,
    response: { status: 200, body: { object: "webhook", id: "4dd369bc", deleted: true } },
  },

  /** Webhook bodies, before signing. */
  events: {
    bounced: JSON.stringify({
      type: "email.bounced",
      created_at: "2026-10-19T12:00:00.000Z",
      data: {
        email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
        to: ["student1@example.org"],
        bounce: { message: "Mailbox does not exist", subType: "General", type: "Permanent" },
        tags: { campaign: "1" },
      },
    }),
    delivered: JSON.stringify({
      type: "email.delivered",
      created_at: "2026-10-19T12:00:00.000Z",
      data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", to: ["student1@example.org"] },
    }),
    complained: JSON.stringify({
      type: "email.complained",
      created_at: "2026-10-19T12:00:00.000Z",
      data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", to: ["student1@example.org"] },
    }),
    opened: JSON.stringify({
      type: "email.opened",
      created_at: "2026-10-19T12:00:00.000Z",
      data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", to: ["student1@example.org"] },
    }),
  },
};

const NOW = Date.parse("2026-10-19T12:00:30.000Z");

/** A Resend webhook request, signed the way Svix signs it. */
async function signedHook(body: string, atMs = NOW, id = "msg_2Lh9KRb0pzN4LePd3XiAG0ZzWdv") {
  const timestamp = Math.floor(atMs / 1000);
  const signature = await svixSign(resendFixtures.webhookSecret, id, timestamp, body);
  return {
    url: "https://envelopen.test/hooks/resend/1/2",
    method: "POST",
    headers: new Headers({
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${signature}`,
    }),
    body,
  };
}

function event(type: string, data: Record<string, unknown> = {}) {
  return JSON.stringify({
    type,
    created_at: "2026-10-19T12:00:00.000Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      to: ["student1@example.org"],
      ...data,
    },
  });
}

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

/** The conformance fixtures of the Resend adapter (U18). */
export const resendConformance: ConformanceFixtures = {
  credentials: resendFixtures.credentials,
  now: NOW,
  emailHeaders: (request) =>
    (JSON.parse(request.body) as { headers: Record<string, string> }[]).map(
      (email) => email.headers,
    ),
  send: {
    allSent: { size: 2, exchanges: [resendFixtures.batchAllSent] },
    partial: {
      size: 3,
      exchanges: [resendFixtures.batchPartial],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "validation" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      exchanges: [resendFixtures.batchRateLimited],
      reason: "rate_limited",
      retryAfterMs: 2000,
    },
    permanent: { exchanges: [resendFixtures.batchDailyQuota], reason: "quota" },
    uncertain: { exchanges: [resendFixtures.batchServerError] },
  },
  connect: {
    ok: [resendFixtures.domainsOk],
    badKey: [resendFixtures.domainsInvalidKey],
    // Resend answers a wrong key with 400 validation_error, not 401.
    badKeyReason: "validation",
  },
  webhook: {
    secret: resendFixtures.webhookSecret,
    valid: () => signedHook(resendFixtures.events.bounced),
    // Ten minutes old: outside the 5 minute Svix window.
    stale: () => signedHook(resendFixtures.events.bounced, NOW - 10 * 60 * 1000),
  },
  events: [
    {
      label: "hard bounce",
      request: () => signedHook(resendFixtures.events.bounced),
      expected: [
        {
          type: "bounce_hard",
          providerMessageId: EMAIL_ID,
          email: "student1@example.org",
          detail: "General",
        },
      ],
    },
    {
      label: "soft bounce",
      request: () =>
        signedHook(
          event("email.bounced", {
            bounce: { message: "Mailbox full", subType: "MailboxFull", type: "Transient" },
          }),
        ),
      expected: [{ type: "bounce_soft", email: "student1@example.org" }],
    },
    {
      label: "delivered",
      request: () => signedHook(resendFixtures.events.delivered),
      expected: [{ type: "delivered", providerMessageId: EMAIL_ID }],
    },
    {
      label: "complaint",
      request: () => signedHook(resendFixtures.events.complained),
      expected: [{ type: "complaint", email: "student1@example.org" }],
    },
    {
      label: "failed",
      request: () =>
        signedHook(event("email.failed", { failed: { reason: "reached_daily_quota" } })),
      expected: [{ type: "failed", detail: "reached_daily_quota" }],
    },
    {
      label: "open, which comes from Envelopen tracking",
      request: () => signedHook(resendFixtures.events.opened),
      expected: [],
    },
  ],
};
