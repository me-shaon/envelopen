// Cloudflare Email Sending REST exchanges, in the shapes of
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ (checked 2026-10-19).

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SEND = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`;

export const cloudflareFixtures = {
  credentials: { accountId: ACCOUNT, apiToken: "cf-token" },
  sendOk: {
    label: "send accepted",
    method: "POST",
    url: SEND,
    times: 1,
    response: {
      status: 200,
      body: {
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [], permanent_bounces: [], queued: ["student1@example.org"] },
      },
    },
  },
  sendThrottled: {
    label: "send throttled",
    method: "POST",
    url: SEND,
    times: 1,
    response: {
      status: 429,
      body: { success: false, errors: [{ code: 10004, message: "email.sending.error.throttled" }] },
    },
  },
  sendNotEntitled: {
    label: "send without Workers Paid",
    method: "POST",
    url: SEND,
    response: {
      status: 403,
      body: {
        success: false,
        errors: [{ code: 10105, message: "email.sending.error.not_entitled" }],
      },
    },
  },
  verifyAccountToken: {
    label: "account token verify",
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`,
    response: {
      status: 200,
      body: { success: true, errors: [], result: { id: "t1", status: "active" } },
    },
  },
  verifyAccountTokenFails: {
    label: "account token verify fails",
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`,
    response: {
      status: 401,
      body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] },
    },
  },
  verifyUserTokenFails: {
    label: "user token verify fails",
    method: "GET",
    url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
    response: {
      status: 401,
      body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] },
    },
  },
};
