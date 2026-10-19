import { callProvider, readJson, retryAfterMs, shortMessage } from "../shared/http";
import { mailboxAddress, mailboxName } from "../shared/messages";
import type {
  AdapterContext,
  BatchFailure,
  ConnectionCheck,
  Credentials,
  FailureReason,
  OutgoingMessage,
  ProviderAdapter,
  RecipientResult,
  SendBatchResult,
} from "../types";

// Cloudflare Email Sending through its REST API (KTD16).
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
// https://developers.cloudflare.com/email-service/reference/faq/ ("transactional email only")
//
// The REST API keeps the Worker free of a `send_email` binding, so the Deploy button
// works on Workers Free. Sending to arbitrary recipients needs Workers Paid. The REST
// response has no message id, and events reach a Cloudflare Queue, not a webhook, so
// Envelopen receives no events from this provider in v1.

const API = "https://api.cloudflare.com/client/v4";
const BATCH_SIZE = 25;
const CONCURRENCY = 5;

function headers(credentials: Credentials) {
  return {
    authorization: `Bearer ${credentials.apiToken ?? ""}`,
    "content-type": "application/json",
  };
}

interface CloudflareBody {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[] };
}

/** Maps an Email Sending error to the classes of KTD12. */
export function classifyCloudflareError(
  status: number,
  code: number,
): { outcome: "not_sent" | "unknown"; reason: FailureReason; stop: boolean } {
  if (status >= 500) return { outcome: "unknown", reason: "server_error", stop: false };
  if (status === 429 || code === 10004)
    return { outcome: "not_sent", reason: "rate_limited", stop: true };
  if (status === 401 || status === 403) return { outcome: "not_sent", reason: "auth", stop: true };
  return { outcome: "not_sent", reason: "validation", stop: false };
}

// The REST page does not show a sender with a display name. This uses the shape of the
// Workers binding, `{ email, name }`. Unverified against a real send.
function payload(message: OutgoingMessage) {
  const name = mailboxName(message.from);
  return {
    from: name ? { email: mailboxAddress(message.from), name } : mailboxAddress(message.from),
    to: message.to,
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    headers: { ...message.headers },
  };
}

async function sendOne(
  message: OutgoingMessage,
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<{ result: RecipientResult; failure?: BatchFailure }> {
  const url = `${API}/accounts/${encodeURIComponent(credentials.accountId ?? "")}/email/sending/send`;
  const call = await callProvider(ctx, url, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify(payload(message)),
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
  const body = (await readJson(call.response)) as CloudflareBody | null;
  if (call.response.ok && body?.success) {
    if (body.result?.permanent_bounces?.includes(message.to)) {
      return {
        result: {
          recipientId: message.recipientId,
          outcome: "not_sent",
          reason: "rejected",
          message: "Cloudflare suppressed the address after an earlier bounce.",
        },
      };
    }
    return { result: { recipientId: message.recipientId, outcome: "sent" } };
  }
  const error = body?.errors?.[0];
  const classified = classifyCloudflareError(call.response.status, error?.code ?? 0);
  const text = shortMessage(error?.message, `Cloudflare returned ${call.response.status}.`);
  const retry = retryAfterMs(call.response);
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
            outcome: "not_sent",
            reason: classified.reason,
            message: text,
            status: call.response.status,
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
  const results: RecipientResult[] = new Array(messages.length);
  let failure: BatchFailure | undefined;
  let next = 0;
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
  return failure ? { results, failure } : { results };
}

/** Checks the API token. Account tokens verify under the account, user tokens under the user. */
async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const account = encodeURIComponent(credentials.accountId ?? "");
  let lastStatus = 0;
  for (const path of [`/accounts/${account}/tokens/verify`, "/user/tokens/verify"]) {
    const call = await callProvider(ctx, `${API}${path}`, { headers: headers(credentials) });
    if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
    lastStatus = call.response.status;
    const body = (await readJson(call.response)) as
      | (CloudflareBody & { result?: { status?: string } })
      | null;
    if (call.response.ok && body?.success) {
      const status = (body.result as { status?: string } | undefined)?.status;
      if (status && status !== "active") {
        return { ok: false, reason: "auth", message: `The API token is ${status}.` };
      }
      return {
        ok: true,
        account: null,
        warnings: [
          "Cloudflare Email Sending needs Workers Paid to send to any address. On Workers Free it sends only to verified addresses of your account.",
        ],
      };
    }
    if (call.response.status >= 500) {
      return {
        ok: false,
        reason: "server_error",
        message: `Cloudflare returned ${call.response.status}.`,
      };
    }
  }
  return {
    ok: false,
    reason: "auth",
    message:
      lastStatus === 0
        ? "Cloudflare did not answer."
        : "Cloudflare rejected the API token. Check the token and the account ID.",
  };
}

export const cloudflareAdapter: ProviderAdapter = {
  id: "cloudflare",
  name: "Cloudflare Email Sending",
  policy: "transactional-only",
  policyWarning:
    "Cloudflare Email Sending supports transactional email only. Campaigns through it break Cloudflare's terms and can get sending turned off for your account.",
  credentialFields: [
    {
      name: "accountId",
      label: "Account ID",
      secret: false,
      required: true,
      pattern: "^[a-f0-9]{32}$",
      hint: "On the Overview page of your Cloudflare dashboard.",
    },
    {
      name: "apiToken",
      label: "API token",
      secret: true,
      required: true,
      hint: "A token with the Email Sending permission for the account.",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "recipient",
    eventTypes: [],
    customHeaders: true,
    autoWebhook: false,
  },
  facts: {
    ratePerSecond: 5,
    requiresWorkersPaid: true,
    notes: [
      "Needs Workers Paid. 3,000 emails per month are included, then 0.35 USD per 1,000.",
      "New accounts start with a low daily quota that grows over time.",
      "Events go to a Cloudflare Queue, not a webhook. Envelopen v1 does not read them, so bounces are not reported.",
    ],
    docsUrl: "https://developers.cloudflare.com/email-service/",
  },
  dns: { spfInclude: null, dkimSelectors: [] },
  manualSecret: "none",

  connect,
  sendBatch,

  async verifyWebhook() {
    return { ok: false, reason: "Cloudflare Email Sending has no webhooks." };
  },

  parseEvents() {
    return { events: [] };
  },

  manualSteps() {
    return [
      "Onboard your sending domain in the Cloudflare dashboard under Email Service, Email Sending.",
      "Cloudflare publishes bounce and complaint events to a Queue, not a webhook. Envelopen v1 does not read them, so check bounces in the Cloudflare dashboard.",
    ];
  },
};
