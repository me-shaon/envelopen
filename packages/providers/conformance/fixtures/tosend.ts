import { toSendSignature } from "../../src/tosend";
import type { ConformanceFixtures } from "./types";

// toSend exchanges, in the shapes of https://tosend.com/docs (checked 2026-10-19).
// Ids are made up.

const API = "https://api.tosend.com";

export const toSendFixtures = {
  credentials: { apiKey: "tsend_test0123456789" },
  adminCredentials: { apiKey: "tsend_admin_test0123456789" },
  info: {
    label: "GET /v2/info",
    method: "GET",
    url: `${API}/v2/info`,
    response: {
      status: 200,
      body: {
        account: { id: "acc_1", status: "active", credit_balance: 9800, limit_per_second: 10 },
        domains: [
          { id: "dom_1", domain_name: "mail.example.com", verification_status: "verified" },
        ],
      },
    },
  },
  infoUnauthorized: {
    label: "GET /v2/info with a wrong key",
    method: "GET",
    url: `${API}/v2/info`,
    response: { status: 401, body: { status_code: 401, message: "Invalid API key" } },
  },
  batchPartial: {
    label: "207 batch: success, error, spam",
    method: "POST",
    url: `${API}/v2/emails/batch`,
    response: {
      status: 207,
      body: {
        results: [
          { status: "success", message_id: "0100019a-tosend-1" },
          {
            status: "error",
            status_code: 422,
            error_type: "validation_error",
            message: "The to field is invalid.",
          },
          { status: "spam", message: "The content looks like spam.", errors: {} },
        ],
      },
    },
  },
  batchNoCredits: {
    label: "403 insufficient credits",
    method: "POST",
    url: `${API}/v2/emails/batch`,
    response: {
      status: 403,
      body: {
        status_code: 403,
        message: "Insufficient credit balance",
        errors: { credit_balance: 2, current_usage: 0, available: 2 },
      },
    },
  },
  webhookCreated: {
    label: "POST /v2/webhooks with an admin key",
    method: "POST",
    url: `${API}/v2/webhooks`,
    response: {
      status: 201,
      body: { id: "wh_1", url: "https://example.com", secret: "tosend-secret-1" },
    },
  },
  events: {
    bounced: JSON.stringify({
      type: "bounced",
      created_at: "2026-10-19T12:00:00Z",
      data: {
        email: "student1@example.org",
        bounce_type: "Permanent",
        bounce_sub_type: "General",
        is_hard_bounce: true,
        sender_fault: false,
        reason: "550 5.1.1 user unknown",
        timestamp: "2026-10-19T12:00:00Z",
        message_id: "0100019a-tosend-1",
      },
    }),
    complaint: JSON.stringify({
      type: "complaint",
      created_at: "2026-10-19T12:00:00Z",
      data: {
        email: "student1@example.org",
        feedback_type: "abuse",
        reason: "",
        timestamp: "2026-10-19T12:00:00Z",
        message_id: "0100019a-tosend-1",
      },
    }),
  },
};

const SECRET = "tosend-secret-1";

/** A toSend webhook request with the `X-ToSend-Signature` header. */
async function signedHook(body: string) {
  return {
    url: "https://envelopen.test/hooks/tosend/1/2",
    method: "POST",
    headers: new Headers({ "x-tosend-signature": await toSendSignature(SECRET, body) }),
    body,
  };
}

const BATCH = `${API}/v2/emails/batch`;

/** The conformance fixtures of the toSend adapter (U18). */
export const toSendConformance: ConformanceFixtures = {
  credentials: toSendFixtures.credentials,
  emailHeaders: (request) =>
    (JSON.parse(request.body) as { emails: { headers: Record<string, string> }[] }).emails.map(
      (email) => email.headers,
    ),
  send: {
    allSent: {
      exchanges: [
        {
          label: "200 batch, both accepted",
          method: "POST",
          url: BATCH,
          response: {
            status: 200,
            body: {
              results: [
                { status: "success", message_id: "0100019a-tosend-1" },
                { status: "success", message_id: "0100019a-tosend-2" },
              ],
            },
          },
        },
      ],
    },
    partial: {
      size: 3,
      exchanges: [toSendFixtures.batchPartial],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "validation" },
        { outcome: "not_sent", reason: "rejected" },
      ],
    },
    retryable: {
      exchanges: [
        {
          label: "429 throttled",
          method: "POST",
          url: BATCH,
          response: {
            status: 429,
            headers: { "retry-after": "1" },
            body: { status_code: 429, message: "Too many requests" },
          },
        },
      ],
      reason: "rate_limited",
      retryAfterMs: 1000,
    },
    permanent: { exchanges: [toSendFixtures.batchNoCredits], reason: "credits" },
    uncertain: {
      exchanges: [
        {
          label: "502 bad gateway",
          method: "POST",
          url: BATCH,
          response: { status: 502, body: "Bad Gateway" },
        },
      ],
    },
  },
  connect: { ok: [toSendFixtures.info], badKey: [toSendFixtures.infoUnauthorized] },
  webhook: {
    secret: SECRET,
    valid: () => signedHook(toSendFixtures.events.bounced),
  },
  events: [
    {
      label: "hard bounce",
      request: () => signedHook(toSendFixtures.events.bounced),
      expected: [
        {
          type: "bounce_hard",
          providerMessageId: "0100019a-tosend-1",
          email: "student1@example.org",
          detail: "General",
        },
      ],
    },
    {
      label: "soft bounce",
      request: () =>
        signedHook(
          JSON.stringify({
            type: "bounced",
            created_at: "2026-10-19T12:00:00Z",
            data: {
              email: "student2@example.org",
              bounce_type: "Transient",
              bounce_sub_type: "MailboxFull",
              is_hard_bounce: false,
              timestamp: "2026-10-19T12:00:00Z",
              message_id: "0100019a-tosend-2",
            },
          }),
        ),
      expected: [{ type: "bounce_soft", email: "student2@example.org", detail: "MailboxFull" }],
    },
    {
      label: "complaint",
      request: () => signedHook(toSendFixtures.events.complaint),
      expected: [{ type: "complaint", email: "student1@example.org", detail: "abuse" }],
    },
  ],
  skip: {
    "webhook.stale":
      "toSend signs only the body, with no timestamp. Envelopen stores each event once by its id.",
  },
};
