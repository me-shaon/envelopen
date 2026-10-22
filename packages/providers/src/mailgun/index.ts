import { bytesToBase64, utf8 } from "../shared/encoding";
import { callProvider, readJson, retryAfterMs, shortMessage } from "../shared/http";
import type {
  AdapterContext,
  BatchFailure,
  ConnectionCheck,
  Credentials,
  EventsSetup,
  FailureReason,
  OutgoingMessage,
  ProviderAdapter,
  RecipientResult,
  SendBatchResult,
} from "../types";
import {
  bareMessageId,
  MAILGUN_WEBHOOK_EVENTS,
  parseMailgunEvents,
  verifyMailgunWebhook,
} from "./webhooks";

// Mailgun through its HTTP API (KTD15, R25).
// https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview
// https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/batch-sending
// https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domain-webhooks/post-v4-domains--domain--webhooks
//
// One request per recipient, not recipient variables. KTD15 planned batches of up to
// 1,000 recipients with `recipient-variables` and `%recipient.<key>%` placeholders. That
// does not fit how Envelopen sends:
// - Envelopen personalizes each email before the adapter (KTD26). Every recipient has
//   its own HTML (merge fields, signed tracking links, the unsubscribe link) and its own
//   List-Unsubscribe URL. A template with placeholders cannot carry that exactly,
//   unless the whole body goes in a variable: 1,000 bodies in one request pass
//   Mailgun's 25 MB message limit, and Mailgun documents placeholders only in the
//   subject, the body, and the To header, not in custom headers.
// - A batch call returns one id for the whole batch, so Envelopen cannot match events
//   to recipients or report a per-recipient result.
// So each recipient gets one POST to /v3/<domain>/messages, in a pool of 5. A batch of
// 25 stays inside the 50 subrequests of Workers Free (KTD20), like SES.

const BATCH_SIZE = 25;
const CONCURRENCY = 5;

export const MAILGUN_REGIONS = {
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net",
} as const;

export type MailgunRegion = keyof typeof MAILGUN_REGIONS;

/** The API base URL of the connection's region. US is the default. */
export function mailgunBaseUrl(
  credentials: Credentials,
  refs: Readonly<Record<string, string>> = {},
) {
  const region = (credentials.region ?? refs.region ?? "us").toLowerCase();
  return region === "eu" ? MAILGUN_REGIONS.eu : MAILGUN_REGIONS.us;
}

function domainOf(credentials: Credentials, refs: Readonly<Record<string, string>> = {}): string {
  return (credentials.domain ?? refs.domain ?? "").trim().toLowerCase();
}

function headers(credentials: Credentials, extra: Record<string, string> = {}) {
  return {
    accept: "application/json",
    authorization: `Basic ${bytesToBase64(utf8(`api:${credentials.apiKey ?? ""}`))}`,
    ...extra,
  };
}

/** A Mailgun error body: JSON with `message`, or plain text such as "Forbidden". */
async function errorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return shortMessage(body?.message, fallback);
  } catch {
    return shortMessage(text, fallback);
  }
}

/** Words of Mailgun's sending-limit errors, as opposed to a request rate limit. */
const QUOTA_MESSAGE = /\b(sending|message|daily|monthly|hourly|account|plan)\s+limit|\bquota\b/i;

/** Maps a Mailgun error to the classes of KTD12. https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview */
export function classifyMailgunError(
  status: number,
  message = "",
): { outcome: "not_sent" | "unknown"; reason: FailureReason; stop: boolean } {
  if (status >= 500) return { outcome: "unknown", reason: "server_error", stop: false };
  if (QUOTA_MESSAGE.test(message) && !/\brate limit/i.test(message)) {
    return { outcome: "not_sent", reason: "quota", stop: true };
  }
  if (status === 429) return { outcome: "not_sent", reason: "rate_limited", stop: true };
  if (status === 401 || status === 403) return { outcome: "not_sent", reason: "auth", stop: true };
  if (status === 402) return { outcome: "not_sent", reason: "credits", stop: true };
  // The domain does not exist in this account and region.
  if (status === 404) return { outcome: "not_sent", reason: "auth", stop: true };
  return { outcome: "not_sent", reason: "validation", stop: false };
}

/**
 * The wait before a retry: `Retry-After` when Mailgun sends it, otherwise
 * `X-RateLimit-Reset`, which is the reset time in Unix milliseconds.
 */
export function mailgunRetryAfterMs(response: Response, now = Date.now()): number | undefined {
  const retry = retryAfterMs(response, now);
  if (retry !== undefined) return retry;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  // A value in seconds is far in the past as milliseconds. Read it as seconds.
  const at = reset < 1e12 ? reset * 1000 : reset;
  return Math.max(0, at - now);
}

/** The form body of one email. Envelopen tracks opens and clicks itself (KTD26). */
export function mailgunForm(message: OutgoingMessage): URLSearchParams {
  const form = new URLSearchParams();
  form.set("from", message.from);
  form.set("to", message.to);
  form.set("subject", message.subject);
  form.set("html", message.html);
  if (message.text) form.set("text", message.text);
  if (message.replyTo) form.set("h:Reply-To", message.replyTo);
  // Custom headers go as `h:` fields, unchanged. This carries both List-Unsubscribe
  // and List-Unsubscribe-Post.
  for (const [name, value] of Object.entries(message.headers)) form.append(`h:${name}`, value);
  form.set("o:tracking", "no");
  form.set("o:tracking-clicks", "no");
  form.set("o:tracking-opens", "no");
  return form;
}

async function sendOne(
  message: OutgoingMessage,
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<{ result: RecipientResult; failure?: BatchFailure }> {
  const url = `${mailgunBaseUrl(credentials, ctx.refs)}/v3/${encodeURIComponent(domainOf(credentials, ctx.refs))}/messages`;
  const call = await callProvider(ctx, url, {
    method: "POST",
    headers: headers(credentials, { "content-type": "application/x-www-form-urlencoded" }),
    body: mailgunForm(message).toString(),
  });
  if (!call.ok) {
    return {
      result: {
        recipientId: message.recipientId,
        outcome: "unknown",
        reason: call.reason,
        message: call.message,
      },
    };
  }
  const { response } = call;
  if (response.ok) {
    const body = (await readJson(response)) as { id?: string } | null;
    const id = bareMessageId(body?.id);
    return {
      result: {
        recipientId: message.recipientId,
        outcome: "sent",
        ...(id ? { providerMessageId: id } : {}),
      },
    };
  }
  const text = await errorMessage(response, `Mailgun returned ${response.status}.`);
  const classified = classifyMailgunError(response.status, text);
  const retry =
    classified.reason === "rate_limited"
      ? mailgunRetryAfterMs(response, (ctx.now ?? Date.now)())
      : undefined;
  return {
    result: {
      recipientId: message.recipientId,
      outcome: classified.outcome,
      reason: classified.reason,
      message: text,
    },
    ...(classified.stop
      ? {
          failure: {
            outcome: "not_sent" as const,
            reason: classified.reason,
            message: text,
            status: response.status,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          },
        }
      : {}),
  };
}

async function sendBatch(
  messages: readonly OutgoingMessage[],
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<SendBatchResult> {
  const results: (RecipientResult | undefined)[] = new Array(messages.length);
  let failure: BatchFailure | undefined;
  let next = 0;
  // After an account-level error (throttle, quota, auth), the messages that did not
  // start are not sent, so a retry cannot send them twice.
  async function worker() {
    while (next < messages.length) {
      const index = next++;
      const message = messages[index] as OutgoingMessage;
      if (failure) {
        results[index] = {
          recipientId: message.recipientId,
          outcome: "not_sent",
          reason: failure.reason,
          message: failure.message,
        };
        continue;
      }
      const sent = await sendOne(message, credentials, ctx);
      results[index] = sent.result;
      if (sent.failure && !failure) failure = sent.failure;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker));
  const done = results as RecipientResult[];
  return failure ? { results: done, failure } : { results: done };
}

interface MailgunDomain {
  domain?: { name?: string; state?: string; type?: string };
}

async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const domain = domainOf(credentials);
  const region = mailgunBaseUrl(credentials) === MAILGUN_REGIONS.eu ? "eu" : "us";
  const call = await callProvider(
    ctx,
    `${mailgunBaseUrl(credentials)}/v3/domains/${encodeURIComponent(domain)}`,
    { headers: headers(credentials) },
  );
  if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
  const { response } = call;
  if (!response.ok) {
    const text = await errorMessage(response, `Mailgun returned ${response.status}.`);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "auth",
        message: `Mailgun rejected the API key in the ${region.toUpperCase()} region. Check the key and the region.`,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        reason: "validation",
        message: `Mailgun has no domain ${domain} in the ${region.toUpperCase()} region. Check the domain and the region.`,
      };
    }
    const classified = classifyMailgunError(response.status, text);
    return { ok: false, reason: classified.reason, message: text };
  }
  const body = (await readJson(response)) as MailgunDomain | null;
  const warnings: string[] = [];
  if (body?.domain?.type === "sandbox") {
    warnings.push(
      "This is a Mailgun sandbox domain. It sends only to authorized recipients. Add your own domain in Mailgun to send campaigns.",
    );
  }
  if (body?.domain?.state && body.domain.state !== "active") {
    warnings.push(
      `Mailgun shows the domain as ${body.domain.state}. Finish its DNS records in Mailgun before you send.`,
    );
  }
  return {
    ok: true,
    account: `${body?.domain?.name ?? domain}, ${region.toUpperCase()} region`,
    warnings,
    refs: { region, domain },
  };
}

async function setupEvents(
  credentials: Credentials,
  target: { url: string },
  ctx: AdapterContext,
): Promise<EventsSetup> {
  const signingKey = credentials.webhookSigningKey?.trim();
  if (!signingKey) return { mode: "manual", reason: "The webhook signing key is missing." };
  const form = new URLSearchParams();
  form.set("url", target.url);
  for (const event of MAILGUN_WEBHOOK_EVENTS) form.append("event_types", event);
  const call = await callProvider(
    ctx,
    `${mailgunBaseUrl(credentials, ctx.refs)}/v4/domains/${encodeURIComponent(domainOf(credentials, ctx.refs))}/webhooks`,
    {
      method: "POST",
      headers: headers(credentials, { "content-type": "application/x-www-form-urlencoded" }),
      body: form.toString(),
    },
  );
  if (!call.ok) return { mode: "manual", reason: call.message };
  if (!call.response.ok) {
    return {
      mode: "manual",
      reason: await errorMessage(
        call.response,
        `Mailgun did not create the webhook (${call.response.status}).`,
      ),
    };
  }
  return { mode: "auto", secret: signingKey, refs: { webhookUrl: target.url } };
}

async function teardownEvents(credentials: Credentials, ctx: AdapterContext): Promise<void> {
  const url = ctx.refs.webhookUrl;
  if (!url) return;
  // Only Envelopen's URL goes. Other webhooks of the domain stay.
  await callProvider(
    ctx,
    `${mailgunBaseUrl(credentials, ctx.refs)}/v4/domains/${encodeURIComponent(domainOf(credentials, ctx.refs))}/webhooks?url=${encodeURIComponent(url)}`,
    { method: "DELETE", headers: headers(credentials) },
  );
}

export const mailgunAdapter: ProviderAdapter = {
  id: "mailgun",
  name: "Mailgun",
  policy: "campaign",
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      hint: "A Mailgun API key from API Security. A domain sending key cannot create the webhook.",
    },
    {
      name: "domain",
      label: "Sending domain",
      secret: false,
      required: true,
      placeholder: "mg.example.com",
      hint: "The domain as Mailgun lists it under Domains.",
      pattern: "^([A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}$",
    },
    {
      name: "region",
      label: "Region",
      secret: false,
      required: true,
      defaultValue: "us",
      options: [
        { value: "us", label: "US (api.mailgun.net)" },
        { value: "eu", label: "EU (api.eu.mailgun.net)" },
      ],
      hint: "The region of your Mailgun account. An EU account uses the EU region.",
      pattern: "^(us|eu)$",
    },
    {
      name: "webhookSigningKey",
      label: "HTTP webhook signing key",
      secret: true,
      required: true,
      hint: "From API Security in Mailgun. It is not the API key. Envelopen checks each event with it.",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "recipient",
    eventTypes: ["delivered", "bounce_hard", "bounce_soft", "complaint"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: 10,
    requiresWorkersPaid: false,
    notes: [
      "Envelopen sends one request per recipient, so each email keeps its own personalized HTML and unsubscribe link.",
      "Mailgun publishes no fixed request rate. Envelopen starts at 10 emails per second and backs off on 429.",
      "The Free plan sends 100 emails per day. Set the daily cap of the connection to 100 on that plan.",
    ],
    docsUrl: "https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview",
  },
  dns: {
    spfInclude: "mailgun.org",
    dkimSelectors: ["smtp", "mx", "k1", "pic", "krs"],
  },
  manualSecret: "provider",
  webhookSecretField: "webhookSigningKey",

  connect,
  sendBatch,
  setupEvents,
  teardownEvents,

  verifyWebhook(request, secret, ctx) {
    return verifyMailgunWebhook(request, secret, (ctx.now ?? Date.now)());
  },

  parseEvents: parseMailgunEvents,

  manualSteps(target) {
    return [
      "In Mailgun, open Send, then Sending, then Webhooks, and select your sending domain.",
      `Add this URL for the events Delivered messages, Permanent failure, Temporary failure, Spam complaints, and Unsubscribes: ${target.url}`,
      "Envelopen checks each event with the HTTP webhook signing key from API Security. Paste that key into Envelopen.",
    ];
  },
};
