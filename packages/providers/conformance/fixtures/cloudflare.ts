import type { RecordedExchange, RecordedResponse } from "../mock-fetch";
import type { ConformanceFixtures } from "./types";

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

/** A send exchange that answers each request by its `to` address. */
function sendBy(label: string, answer: (to: string) => RecordedResponse): RecordedExchange {
  return {
    label,
    method: "POST",
    url: SEND,
    response: (request) => answer((JSON.parse(request.body) as { to: string }).to),
  };
}

const QUEUED = (to: string): RecordedResponse => ({
  status: 200,
  body: { success: true, errors: [], messages: [], result: { delivered: [], queued: [to] } },
});

/** The conformance fixtures of the Cloudflare Email Sending adapter (U18). */
export const cloudflareConformance: ConformanceFixtures = {
  credentials: cloudflareFixtures.credentials,
  // One email per request, with the headers as an object.
  emailHeaders: (request) => [
    (JSON.parse(request.body) as { headers: Record<string, string> }).headers,
  ],
  send: {
    allSent: { exchanges: [sendBy("each send accepted", QUEUED)] },
    partial: {
      size: 3,
      exchanges: [
        sendBy("the second address is invalid", (to) =>
          to === "student2@example.org"
            ? {
                status: 400,
                body: {
                  success: false,
                  errors: [{ code: 10001, message: "email.sending.error.invalid_request_schema" }],
                },
              }
            : QUEUED(to),
        ),
      ],
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "validation" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      exchanges: [
        {
          ...cloudflareFixtures.sendThrottled,
          times: undefined,
          response: {
            ...cloudflareFixtures.sendThrottled.response,
            headers: { "retry-after": "5" },
          },
        },
      ],
      reason: "rate_limited",
      retryAfterMs: 5000,
    },
    permanent: { exchanges: [cloudflareFixtures.sendNotEntitled], reason: "auth" },
    uncertain: {
      exchanges: [
        sendBy("500 internal error", () => ({
          status: 500,
          body: { success: false, errors: [{ code: 10000, message: "internal error" }] },
        })),
      ],
    },
  },
  connect: {
    ok: [cloudflareFixtures.verifyAccountToken],
    badKey: [cloudflareFixtures.verifyAccountTokenFails, cloudflareFixtures.verifyUserTokenFails],
  },
};
