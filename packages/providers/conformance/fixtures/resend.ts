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
