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
