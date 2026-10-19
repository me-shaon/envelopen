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
