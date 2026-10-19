import type { WebhookRequest } from "../../../src/types";
import type { ConformanceFixtures } from "../../fixtures/types";
import type { RecordedExchange } from "../../mock-fetch";
import { lettermillSignature } from "./adapter";

// Lettermill is fictional, so it has no test account. These exchanges copy the examples
// of the Lettermill API spec in the task brief (https://api.lettermill.example/docs),
// checked 2026-10-19. Ids and keys are made up.

const API = "https://api.lettermill.example";
const BATCH_URL = `${API}/v1/messages/batch`;
const ACCOUNT_URL = `${API}/v1/account`;

const NOW = Date.parse("2026-10-19T12:00:00Z");
const SECRET = "lmwhsec_test0secret0value";

const invalidKey = {
  status: 401,
  body: { error: { code: "invalid_key", message: "The API key is not valid." } },
};

function batch(label: string, response: RecordedExchange["response"]): RecordedExchange[] {
  return [{ label, method: "POST", url: BATCH_URL, response }];
}

async function signed(body: object, at = NOW): Promise<WebhookRequest> {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(at / 1000));
  return {
    url: "https://app.example.com/webhooks/lettermill",
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "lettermill-timestamp": timestamp,
      "lettermill-signature": await lettermillSignature(SECRET, timestamp, text),
    }),
    body: text,
  };
}

function event(type: string, data: Record<string, string>, id = "evt_1"): object {
  return {
    id,
    type,
    created_at: "2026-10-19T11:59:00Z",
    data: { message_id: "lm_msg_1", recipient: "student1@example.org", ...data },
  };
}

const OCCURRED_AT = Date.parse("2026-10-19T11:59:00Z");

export const lettermillConformance: ConformanceFixtures = {
  credentials: { apiKey: "lm_live_test0key0123" },
  now: NOW,
  emailHeaders: (request) =>
    (JSON.parse(request.body) as { messages: { headers: Record<string, string> }[] }).messages.map(
      (email) => email.headers,
    ),

  send: {
    allSent: {
      exchanges: batch("batch of two, both accepted", {
        status: 200,
        body: {
          results: [
            { status: "accepted", id: "lm_msg_1" },
            { status: "accepted", id: "lm_msg_2" },
          ],
        },
      }),
    },
    partial: {
      size: 3,
      exchanges: batch("batch of three, one invalid and one suppressed", {
        status: 207,
        body: {
          results: [
            { status: "accepted", id: "lm_msg_1" },
            {
              status: "rejected",
              code: "invalid_recipient",
              message: "The recipient address is not valid.",
            },
            { status: "rejected", code: "suppressed", message: "The recipient is suppressed." },
          ],
        },
      }),
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "validation" },
        { outcome: "not_sent", reason: "rejected" },
      ],
    },
    retryable: {
      exchanges: batch("rate limited", {
        status: 429,
        headers: { "retry-after": "2" },
        body: { error: { code: "rate_limited", message: "Too many requests." } },
      }),
      reason: "rate_limited",
      retryAfterMs: 2000,
    },
    permanent: {
      exchanges: batch("no credits left", {
        status: 402,
        body: {
          error: { code: "insufficient_credits", message: "The account has no credits left." },
        },
      }),
      reason: "credits",
    },
    uncertain: {
      exchanges: batch("server error", { status: 503, body: "Service Unavailable" }),
    },
  },

  connect: {
    ok: [
      {
        label: "account of a good key",
        method: "GET",
        url: ACCOUNT_URL,
        response: { status: 200, body: { account: { name: "Course Academy", plan: "growth" } } },
      },
    ],
    badKey: [{ label: "wrong key", method: "GET", url: ACCOUNT_URL, response: invalidKey }],
  },

  webhook: {
    secret: SECRET,
    valid: () => signed(event("message.delivered", {})),
    stale: () => signed(event("message.delivered", {}), NOW - 10 * 60 * 1000),
  },

  events: [
    {
      label: "delivered",
      request: () => signed(event("message.delivered", {}, "evt_delivered")),
      expected: [
        {
          type: "delivered",
          eventId: "evt_delivered",
          providerMessageId: "lm_msg_1",
          email: "student1@example.org",
          occurredAt: OCCURRED_AT,
        },
      ],
    },
    {
      label: "hard bounce",
      request: () => signed(event("message.bounced", { bounce_kind: "hard" }, "evt_hard")),
      expected: [{ type: "bounce_hard", eventId: "evt_hard", detail: "hard" }],
    },
    {
      label: "soft bounce",
      request: () => signed(event("message.bounced", { bounce_kind: "soft" }, "evt_soft")),
      expected: [{ type: "bounce_soft", eventId: "evt_soft", detail: "soft" }],
    },
    {
      label: "complaint",
      request: () => signed(event("message.complained", {}, "evt_complaint")),
      expected: [{ type: "complaint", eventId: "evt_complaint" }],
    },
    {
      label: "open, skipped",
      request: () => signed(event("message.opened", {}, "evt_open")),
      expected: [],
    },
  ],
};
