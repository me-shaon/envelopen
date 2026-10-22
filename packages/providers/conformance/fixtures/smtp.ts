import type { WebhookRequest } from "../../src/types";
import { parseMail } from "../mock-smtp";
import type { ConformanceFixtures } from "./types";

// The conformance fixtures of the SMTP adapter with the Brevo preset (U18). The mock
// SMTP server of mock-smtp.ts plays the Brevo relay, so no test reaches Brevo. The
// webhook bodies follow https://developers.brevo.com/docs/transactional-webhooks
// (checked 2026-10-22).

const LOGIN = "owner@example.com";
const SMTP_KEY = "xsmtpsib-conformance-key";
const TOKEN = "brevo-bearer-token-for-the-conformance-kit-0001";
const HOOK_URL = "https://envelopen.test/hooks/smtp/1/2";
const NOW = Date.UTC(2026, 9, 22, 9, 30, 0);
const SERVER = { username: LOGIN, password: SMTP_KEY };

/** A Brevo webhook request with the bearer token. */
export function brevoRequest(body: unknown, token = TOKEN, url = HOOK_URL): WebhookRequest {
  return {
    url,
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    }),
    body: JSON.stringify(body),
  };
}

/** A Brevo transactional event, as Brevo sends it. */
export function brevoEvent(event: string, extra: Record<string, unknown> = {}) {
  return {
    event,
    email: "student1@example.org",
    id: 26224,
    date: "2026-10-22 11:30:00",
    ts: NOW / 1000,
    "message-id": "<0123456789abcdef0123456789abcdef@mail.example.com>",
    ts_event: NOW / 1000,
    subject: "A new course starts Monday",
    tag: "",
    sending_ip: "185.41.28.109",
    ts_epoch: NOW,
    ...extra,
  };
}

export const brevoFixtures = {
  login: LOGIN,
  smtpKey: SMTP_KEY,
  token: TOKEN,
  hookUrl: HOOK_URL,
  now: NOW,
  credentials: { preset: "brevo", username: LOGIN, password: SMTP_KEY },
  refs: { preset: "brevo" },
};

export const smtpConformance: ConformanceFixtures = {
  credentials: brevoFixtures.credentials,
  refs: brevoFixtures.refs,
  now: NOW,
  smtpTimeoutMs: 300,
  emailHeaders: (request) => [Object.fromEntries(parseMail(request.body).headers)],
  send: {
    allSent: { smtp: SERVER },
    partial: {
      size: 3,
      smtp: {
        ...SERVER,
        reply: (command) =>
          command.verb === "RCPT" && command.arg.includes("student2@")
            ? "550 5.1.1 The email account does not exist"
            : undefined,
      },
      expected: [
        { outcome: "sent" },
        { outcome: "not_sent", reason: "rejected" },
        { outcome: "sent" },
      ],
    },
    retryable: {
      smtp: {
        ...SERVER,
        reply: (command) =>
          command.verb === "MAIL" ? "451 4.7.1 Too many messages, slow down" : undefined,
      },
      reason: "rate_limited",
    },
    permanent: {
      smtp: { ...SERVER, password: "another-key" },
      reason: "auth",
    },
    uncertain: {
      smtp: {
        ...SERVER,
        reply: (command) =>
          command.verb === "MAIL" ? "421 4.3.2 Service shutting down" : undefined,
      },
    },
  },
  connect: {
    ok: [],
    badKey: [],
    smtp: { ok: SERVER, badKey: { ...SERVER, password: "another-key" } },
  },
  webhook: {
    secret: TOKEN,
    valid: () => brevoRequest(brevoEvent("hard_bounce", { reason: "550 No such user" })),
  },
  events: [
    {
      label: "hard bounce",
      request: () => brevoRequest(brevoEvent("hard_bounce", { reason: "550 No such user" })),
      expected: [
        {
          type: "bounce_hard",
          email: "student1@example.org",
          providerMessageId: "<0123456789abcdef0123456789abcdef@mail.example.com>",
          occurredAt: NOW,
          detail: "hard_bounce: 550 No such user",
        },
      ],
    },
    {
      label: "invalid email",
      request: () => brevoRequest(brevoEvent("invalid_email")),
      expected: [{ type: "bounce_hard", detail: "invalid_email" }],
    },
    {
      label: "soft bounce",
      request: () => brevoRequest(brevoEvent("soft_bounce", { reason: "Mailbox full" })),
      expected: [{ type: "bounce_soft" }],
    },
    {
      label: "spam complaint",
      request: () => brevoRequest(brevoEvent("spam")),
      expected: [{ type: "complaint" }],
    },
    {
      label: "blocked",
      request: () => brevoRequest(brevoEvent("blocked")),
      expected: [{ type: "failed", detail: "blocked" }],
    },
    {
      label: "unsubscribed goes to the unsubscribes, not the events",
      request: () => brevoRequest(brevoEvent("unsubscribed")),
      expected: [],
    },
    {
      label: "an open is skipped: Envelopen tracks opens",
      request: () => brevoRequest(brevoEvent("opened")),
      expected: [],
    },
  ],
  skip: {
    "send.idempotency": "SMTP has no idempotency key.",
    "webhook.changed":
      "Brevo signs nothing. The bearer token proves the sender, and TLS protects the body in transit.",
    "webhook.stale": "Brevo webhooks carry no signed timestamp.",
  },
};
