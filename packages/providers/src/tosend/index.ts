import { bytesToHex, hmacSha256, timingSafeEqual, utf8 } from "../shared/encoding";
import { callProvider, readJson, retryAfterMs, shortMessage } from "../shared/http";
import { mailboxAddress, mailboxName } from "../shared/messages";
import type {
  AdapterContext,
  BatchFailure,
  ConnectionCheck,
  Credentials,
  EventsSetup,
  FailureReason,
  NormalizedEvent,
  OutgoingMessage,
  ProviderAdapter,
  RecipientResult,
  SendBatchResult,
} from "../types";

// toSend (KTD16): the batch endpoint and HMAC-signed webhooks. Envelopen treats it as
// transactional-only (R62), so a campaign needs the accepted warning. Owner alerts
// (system email) send without it.
// https://tosend.com/docs/api/batch-emails/
// https://tosend.com/docs/guide/webhooks/
// https://tosend.com/docs/api/admin-api/

const API = "https://api.tosend.com";
const BATCH_SIZE = 50;

function headers(credentials: Credentials) {
  return {
    authorization: `Bearer ${credentials.apiKey ?? ""}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

interface ToSendError {
  status_code?: number;
  message?: string;
}

/** Maps a toSend error to the classes of KTD12. https://tosend.com/docs/api/introduction/ */
export function classifyToSendError(
  status: number,
  message: string,
): { outcome: "not_sent" | "unknown"; reason: FailureReason } {
  if (status >= 500) return { outcome: "unknown", reason: "server_error" };
  if (status === 429) return { outcome: "not_sent", reason: "rate_limited" };
  if (status === 401) return { outcome: "not_sent", reason: "auth" };
  if (status === 403) {
    // The whole batch fails with 403 when the balance cannot cover every recipient.
    return { outcome: "not_sent", reason: /credit/i.test(message) ? "credits" : "auth" };
  }
  return { outcome: "not_sent", reason: "validation" };
}

function payload(message: OutgoingMessage) {
  const name = mailboxName(message.from);
  return {
    from: { email: mailboxAddress(message.from), ...(name ? { name } : {}) },
    to: [{ email: message.to }],
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    headers: { ...message.headers },
  };
}

function everyone(messages: readonly OutgoingMessage[], failure: BatchFailure): SendBatchResult {
  return {
    failure,
    results: messages.map((message) => ({
      recipientId: message.recipientId,
      outcome: failure.outcome,
      reason: failure.reason,
      message: failure.message,
    })),
  };
}

async function sendBatch(
  messages: readonly OutgoingMessage[],
  credentials: Credentials,
  ctx: AdapterContext,
): Promise<SendBatchResult> {
  const call = await callProvider(ctx, `${API}/v2/emails/batch`, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify({ emails: messages.map(payload) }),
  });
  // toSend has no idempotency key, so a timeout is unknown and the batch becomes uncertain.
  if (!call.ok) {
    return everyone(messages, { outcome: "unknown", reason: call.reason, message: call.message });
  }
  const { response } = call;
  const body = (await readJson(response)) as
    | (ToSendError & { results?: { status?: string; message_id?: string; message?: string }[] })
    | null;
  // 200: every email accepted. 207: some failed. Results are in input order.
  if ((response.status === 200 || response.status === 207) && Array.isArray(body?.results)) {
    const items = body.results;
    const results: RecipientResult[] = messages.map((message, index) => {
      const item = items[index];
      if (item?.status === "success" && item.message_id) {
        return {
          recipientId: message.recipientId,
          outcome: "sent",
          providerMessageId: item.message_id,
        };
      }
      if (!item) {
        return {
          recipientId: message.recipientId,
          outcome: "unknown",
          reason: "server_error",
          message: "toSend returned no result for this email.",
        };
      }
      return {
        recipientId: message.recipientId,
        outcome: "not_sent",
        reason: item.status === "spam" ? "rejected" : "validation",
        message: shortMessage(item.message, "toSend rejected this email."),
      };
    });
    return { results };
  }
  const message = shortMessage(body?.message, `toSend returned ${response.status}.`);
  const retry = retryAfterMs(response);
  return everyone(messages, {
    ...classifyToSendError(response.status, message),
    message,
    status: response.status,
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
  });
}

async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const call = await callProvider(ctx, `${API}/v2/info`, { headers: headers(credentials) });
  if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
  const body = (await readJson(call.response)) as
    | (ToSendError & {
        account?: { status?: string; credit_balance?: number; limit_per_second?: number };
        domains?: { domain_name?: string; verification_status?: string }[];
      })
    | null;
  if (!call.response.ok) {
    const message = shortMessage(body?.message, `toSend returned ${call.response.status}.`);
    const classified = classifyToSendError(call.response.status, message);
    return {
      ok: false,
      reason: classified.reason,
      message: classified.reason === "auth" ? "toSend rejected the API key." : message,
    };
  }
  const warnings: string[] = [];
  if (body?.account?.status && body.account.status !== "active") {
    warnings.push(`The toSend account status is ${body.account.status}.`);
  }
  if (body?.account?.credit_balance === 0) warnings.push("The toSend account has no credits left.");
  const admin = (credentials.apiKey ?? "").startsWith("tsend_admin_");
  return {
    ok: true,
    account:
      typeof body?.account?.credit_balance === "number"
        ? `${body.account.credit_balance} credits`
        : null,
    warnings,
    refs: { admin: admin ? "true" : "false" },
  };
}

/** An admin key can create the webhook. A sending key gets 401, so it uses manual steps. */
async function setupEvents(
  credentials: Credentials,
  target: { url: string },
  ctx: AdapterContext,
): Promise<EventsSetup> {
  if (ctx.refs.admin !== "true") {
    return { mode: "manual", reason: "Only an admin key can create webhooks in toSend." };
  }
  const call = await callProvider(ctx, `${API}/v2/webhooks`, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify({ title: "Envelopen", url: target.url, events: ["bounced", "complaint"] }),
  });
  if (!call.ok) return { mode: "manual", reason: call.message };
  const raw = (await readJson(call.response)) as
    | (ToSendError & {
        id?: string | number;
        secret?: string;
        data?: { id?: string | number; secret?: string };
      })
    | null;
  const created = raw?.data ?? raw;
  if (!call.response.ok || !created?.secret || created.id === undefined) {
    return {
      mode: "manual",
      reason: shortMessage(
        raw?.message,
        `toSend did not create the webhook (${call.response.status}).`,
      ),
    };
  }
  return { mode: "auto", secret: created.secret, refs: { webhookId: String(created.id) } };
}

async function teardownEvents(credentials: Credentials, ctx: AdapterContext): Promise<void> {
  const id = ctx.refs.webhookId;
  if (!id) return;
  await callProvider(ctx, `${API}/v2/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(credentials),
  });
}

/** The `X-ToSend-Signature` value of a body: `sha256=` and the hex HMAC-SHA256. */
export async function toSendSignature(secret: string, body: string): Promise<string> {
  return `sha256=${bytesToHex(await hmacSha256(utf8(secret), body))}`;
}

interface ToSendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email?: string;
    bounce_type?: string;
    bounce_sub_type?: string;
    is_hard_bounce?: boolean;
    feedback_type?: string;
    timestamp?: string;
    message_id?: string;
  };
}

export const toSendAdapter: ProviderAdapter = {
  id: "tosend",
  name: "toSend",
  policy: "transactional-only",
  policyWarning:
    "Envelopen treats toSend as a transactional provider. Campaigns through it can break the provider's terms or hurt your sender reputation. toSend allows marketing email only to people who asked for it, with a visible unsubscribe link in the body.",
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "tsend_...",
      pattern: "^tsend_[A-Za-z0-9_]+$",
      hint: "An admin key with webhooks:write lets Envelopen create the webhook for you.",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "request",
    eventTypes: ["bounce_hard", "bounce_soft", "complaint"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: 10,
    requiresWorkersPaid: false,
    notes: [
      "10 batch requests per second per team.",
      "toSend reports bounces and complaints only, so delivered counts show as not reported.",
      "toSend sends each webhook once, with no retry.",
    ],
    docsUrl: "https://tosend.com/docs/api/batch-emails/",
  },
  dns: { spfInclude: "amazonses.com", dkimSelectors: [] },
  manualSecret: "envelopen",

  connect,
  sendBatch,
  setupEvents,
  teardownEvents,

  async verifyWebhook(request, secret) {
    const header = request.headers.get("x-tosend-signature");
    if (!secret || !header) return { ok: false, reason: "Missing signature." };
    // The signature covers only the body, so a replay passes. Envelopen stores each
    // event once by its id instead.
    const expected = await toSendSignature(secret, request.body);
    return timingSafeEqual(header.trim(), expected)
      ? { ok: true }
      : { ok: false, reason: "The signature does not match." };
  },

  parseEvents(request) {
    let event: ToSendEvent;
    try {
      event = JSON.parse(request.body) as ToSendEvent;
    } catch {
      return { events: [] };
    }
    const data = event.data;
    if (!data?.email) return { events: [] };
    const at = Date.parse(data.timestamp ?? event.created_at ?? "");
    const occurredAt = Number.isNaN(at) ? Date.now() : at;
    const base = {
      eventId: `${event.type}:${data.message_id}:${data.email.toLowerCase()}`,
      providerMessageId: data.message_id ?? null,
      email: data.email,
      occurredAt,
    };
    const events: NormalizedEvent[] = [];
    if (event.type === "bounced") {
      const hard = data.is_hard_bounce ?? data.bounce_type === "Permanent";
      events.push({
        ...base,
        type: hard ? "bounce_hard" : "bounce_soft",
        ...(data.bounce_sub_type ? { detail: data.bounce_sub_type } : {}),
      });
    } else if (event.type === "complaint") {
      events.push({
        ...base,
        type: "complaint",
        ...(data.feedback_type ? { detail: data.feedback_type } : {}),
      });
    }
    return { events };
  },

  manualSteps(target) {
    return [
      "In the toSend dashboard, open Webhooks and create a webhook.",
      `Paste this URL: ${target.url}`,
      "Set the secret to the webhook secret below. Envelopen rejects webhooks without it.",
      "Select the Bounced and Complaint events, and save.",
    ];
  },
};
