import { postmarkAuthorization } from "../../src/postmark";
import type { ConformanceFixtures } from "./types";

// Postmark exchanges, in the shapes of https://postmarkapp.com/developer (checked
// 2026-10-19). Ids are made up.

const API = "https://api.postmarkapp.com";

export const postmarkFixtures = {
  credentials: { serverToken: "00000000-0000-4000-8000-000000000000" },
  server: {
    label: "GET /server",
    method: "GET",
    url: `${API}/server`,
    response: { status: 200, body: { ID: 1, Name: "Course Academy" } },
  },
  serverBadToken: {
    label: "GET /server with a wrong token",
    method: "GET",
    url: `${API}/server`,
    response: { status: 401, body: { ErrorCode: 10, Message: "Bad or missing Server API token." } },
  },
  streams: (handling: "Custom" | "Postmark") => ({
    label: "GET /message-streams for broadcasts",
    method: "GET",
    url: `${API}/message-streams?MessageStreamType=Broadcasts`,
    response: {
      status: 200,
      body: {
        MessageStreams: [
          {
            ID: "broadcasts",
            Name: "Broadcasts",
            MessageStreamType: "Broadcasts",
            ArchivedAt: null,
            SubscriptionManagementConfiguration: { UnsubscribeHandlingType: handling },
          },
        ],
        TotalCount: 1,
      },
    },
  }),
  noStreams: {
    label: "GET /message-streams with no broadcast stream",
    method: "GET",
    url: `${API}/message-streams?MessageStreamType=Broadcasts`,
    response: { status: 200, body: { MessageStreams: [], TotalCount: 0 } },
  },
  batchPartial: {
    label: "batch of three: sent, inactive recipient, sent",
    method: "POST",
    url: `${API}/email/batch`,
    response: {
      status: 200,
      body: [
        {
          ErrorCode: 0,
          Message: "OK",
          MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
          SubmittedAt: "2026-10-19T12:00:00Z",
          To: "student1@example.org",
        },
        {
          ErrorCode: 406,
          Message: "You tried to send to a recipient that has been marked as inactive.",
        },
        {
          ErrorCode: 0,
          Message: "OK",
          MessageID: "e2ecbbfc-fe12-463d-b933-9fe22915106d",
          SubmittedAt: "2026-10-19T12:00:00Z",
          To: "student3@example.org",
        },
      ],
    },
  },
  batchNotApproved: {
    label: "account pending approval",
    method: "POST",
    url: `${API}/email/batch`,
    response: {
      status: 422,
      body: {
        ErrorCode: 412,
        Message:
          "While your account is pending approval, all recipients must share the same domain as the 'From' address.",
      },
    },
  },
  webhookCreated: {
    label: "POST /webhooks",
    method: "POST",
    url: `${API}/webhooks`,
    response: {
      status: 200,
      body: { ID: 1234567, Url: "https://example.com", MessageStream: "broadcasts" },
    },
  },
  webhookDeleted: {
    label: "DELETE /webhooks/{id}",
    method: "DELETE",
    url: /^https:\/\/api\.postmarkapp\.com\/webhooks\/\d+$/,
    response: { status: 200, body: { ErrorCode: 0, Message: "Webhook 1234567 removed." } },
  },
  events: {
    hardBounce: JSON.stringify({
      RecordType: "Bounce",
      ID: 4323372036854,
      Type: "HardBounce",
      TypeCode: 1,
      MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
      Email: "student1@example.org",
      BouncedAt: "2026-10-19T12:00:00Z",
      MessageStream: "broadcasts",
    }),
    autoResponder: JSON.stringify({
      RecordType: "Bounce",
      ID: 42,
      Type: "AutoResponder",
      TypeCode: 64,
      MessageID: "b7bc2f4a",
      Email: "student1@example.org",
    }),
    delivery: JSON.stringify({
      RecordType: "Delivery",
      MessageID: "e2ecbbfc-fe12-463d-b933-9fe22915106d",
      Recipient: "student3@example.org",
      DeliveredAt: "2026-10-19T12:00:05Z",
      MessageStream: "broadcasts",
    }),
    complaint: JSON.stringify({
      RecordType: "SpamComplaint",
      ID: 43,
      Type: "SpamComplaint",
      TypeCode: 100001,
      MessageID: "e2ecbbfc",
      Email: "student3@example.org",
      BouncedAt: "2026-10-19T12:10:00Z",
    }),
  },
};

const SECRET = "postmark-basic-auth-secret-1";

/** A Postmark webhook request with the Basic auth that Envelopen set on the webhook. */
function hook(body: string, secret = SECRET) {
  return {
    url: "https://envelopen.test/hooks/postmark/1/2",
    method: "POST",
    headers: new Headers({ authorization: postmarkAuthorization(secret) }),
    body,
  };
}

/** The conformance fixtures of the Postmark adapter (U18). */
export const postmarkConformance: ConformanceFixtures = {
  credentials: postmarkFixtures.credentials,
  refs: { messageStream: "broadcasts" },
  emailHeaders: (request) =>
    (JSON.parse(request.body) as { Headers: { Name: string; Value: string }[] }[]).map((email) =>
      Object.fromEntries(email.Headers.map((header) => [header.Name, header.Value])),
    ),
  send: {
    allSent: {
      exchanges: [
        {
          label: "batch of two, both accepted",
          method: "POST",
          url: `${API}/email/batch`,
          response: {
            status: 200,
            body: [
              { ErrorCode: 0, Message: "OK", MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817" },
              { ErrorCode: 0, Message: "OK", MessageID: "e2ecbbfc-fe12-463d-b933-9fe22915106d" },
            ],
          },
        },
      ],
    },
    partial: {
      size: 3,
      exchanges: [postmarkFixtures.batchPartial],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "rejected" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      exchanges: [
        {
          label: "429 rate limit",
          method: "POST",
          url: `${API}/email/batch`,
          response: {
            status: 429,
            headers: { "retry-after": "3" },
            body: { ErrorCode: 0, Message: "Rate limit exceeded." },
          },
        },
      ],
      reason: "rate_limited",
      retryAfterMs: 3000,
    },
    permanent: { exchanges: [postmarkFixtures.batchNotApproved], reason: "auth" },
    uncertain: {
      exchanges: [
        {
          label: "500 server error",
          method: "POST",
          url: `${API}/email/batch`,
          response: { status: 500, body: { ErrorCode: 0, Message: "Internal server error." } },
        },
      ],
    },
  },
  connect: {
    ok: [postmarkFixtures.server, postmarkFixtures.streams("Custom")],
    badKey: [postmarkFixtures.serverBadToken],
  },
  webhook: {
    secret: SECRET,
    valid: () => hook(postmarkFixtures.events.hardBounce),
  },
  events: [
    {
      label: "hard bounce",
      request: () => hook(postmarkFixtures.events.hardBounce),
      expected: [
        {
          type: "bounce_hard",
          eventId: "bounce:4323372036854",
          providerMessageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
          email: "student1@example.org",
        },
      ],
    },
    {
      label: "soft bounce",
      request: () =>
        hook(
          JSON.stringify({
            RecordType: "Bounce",
            ID: 4323372036855,
            Type: "SoftBounce",
            TypeCode: 4096,
            MessageID: "e2ecbbfc-fe12-463d-b933-9fe22915106d",
            Email: "student3@example.org",
            BouncedAt: "2026-10-19T12:00:00Z",
          }),
        ),
      expected: [{ type: "bounce_soft", email: "student3@example.org", detail: "SoftBounce" }],
    },
    {
      label: "delivery",
      request: () => hook(postmarkFixtures.events.delivery),
      expected: [{ type: "delivered", email: "student3@example.org" }],
    },
    {
      label: "spam complaint",
      request: () => hook(postmarkFixtures.events.complaint),
      expected: [{ type: "complaint", email: "student3@example.org" }],
    },
    {
      label: "auto-responder, which is not a bounce",
      request: () => hook(postmarkFixtures.events.autoResponder),
      expected: [],
    },
  ],
  skip: {
    "webhook.changed":
      "Postmark does not sign webhooks. Basic auth proves the sender, but it does not cover the body.",
    "webhook.stale": "Postmark sends no timestamp with its Basic auth.",
  },
};
