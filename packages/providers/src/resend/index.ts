import { callProvider, readJson, retryAfterMs, shortMessage } from "../shared/http";
import type {
  AdapterContext,
  BatchFailure,
  ConnectionCheck,
  Credentials,
  DnsRecordHint,
  EventsSetup,
  FailureReason,
  NormalizedEvent,
  OutgoingMessage,
  ProviderAdapter,
  ProviderEventType,
  RecipientResult,
  SendBatchResult,
} from "../types";
import { svixHeaders, verifySvix } from "./svix-verify";

// Resend (KTD16): the batch endpoint with an Idempotency-Key, and the webhook API.
// https://resend.com/docs/api-reference/emails/send-batch-emails
// https://resend.com/docs/dashboard/emails/idempotency-keys
// https://resend.com/docs/api-reference/webhooks/create-webhook

const API = "https://api.resend.com";
const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const EVENTS = ["email.delivered", "email.bounced", "email.complained", "email.failed"];

function headers(credentials: Credentials, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${credentials.apiKey ?? ""}`,
    "content-type": "application/json",
    ...extra,
  };
}

interface ResendError {
  name?: string;
  message?: string;
}

/** Maps a Resend error to the classes of KTD12. https://resend.com/docs/api-reference/errors */
export function classifyResendError(
  status: number,
  name: string,
): { outcome: "not_sent" | "unknown"; reason: FailureReason } {
  if (status >= 500) return { outcome: "unknown", reason: "server_error" };
  switch (name) {
    case "rate_limit_exceeded":
      return { outcome: "not_sent", reason: "rate_limited" };
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
      return { outcome: "not_sent", reason: "quota" };
    case "missing_api_key":
    case "invalid_api_key":
    case "restricted_api_key":
    case "suspended_api_key":
    case "invalid_permission":
      return { outcome: "not_sent", reason: "auth" };
    // Another request with the same key is running. It may send, so this one is unknown.
    case "concurrent_idempotent_requests":
      return { outcome: "unknown", reason: "server_error" };
    default:
      if (status === 429) return { outcome: "not_sent", reason: "rate_limited" };
      if (status === 401) return { outcome: "not_sent", reason: "auth" };
      return { outcome: "not_sent", reason: "validation" };
  }
}

function emailPayload(message: OutgoingMessage) {
  return {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    headers: { ...message.headers },
  };
}

async function sendBatch(
  messages: readonly OutgoingMessage[],
  credentials: Credentials,
  ctx: AdapterContext & { idempotencyKey?: string },
): Promise<SendBatchResult> {
  const call = await callProvider(ctx, `${API}/emails/batch`, {
    method: "POST",
    headers: headers(credentials, {
      // Permissive mode returns per-item errors instead of failing the whole batch.
      "x-batch-validation": "permissive",
      ...(ctx.idempotencyKey ? { "idempotency-key": ctx.idempotencyKey } : {}),
    }),
    body: JSON.stringify(messages.map(emailPayload)),
  });
  if (!call.ok) {
    return everyone(messages, { outcome: "unknown", reason: call.reason, message: call.message });
  }
  const { response } = call;
  const body = (await readJson(response)) as
    | (ResendError & {
        data?: { id?: string }[];
        errors?: { index?: number; message?: string }[];
      })
    | null;
  if (!response.ok) {
    const classified = classifyResendError(response.status, body?.name ?? "");
    const retry = retryAfterMs(response);
    return everyone(messages, {
      ...classified,
      message: shortMessage(body?.message, `Resend returned ${response.status}.`),
      status: response.status,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    });
  }

  const errors = new Map<number, string>();
  for (const item of body?.errors ?? []) {
    if (typeof item.index === "number")
      errors.set(item.index, shortMessage(item.message, "Rejected."));
  }
  const ids = (body?.data ?? []).map((item) => item.id);
  // With every item in `data`, ids match by index. Otherwise `data` lists the accepted
  // items in order, and the failed indexes are skipped.
  const aligned = ids.length === messages.length;
  let cursor = 0;
  const results: RecipientResult[] = messages.map((message, index) => {
    const error = errors.get(index);
    if (error !== undefined) {
      if (aligned) cursor++;
      return {
        recipientId: message.recipientId,
        outcome: "not_sent",
        reason: "validation",
        message: error,
      };
    }
    const id = ids[aligned ? index : cursor++];
    return id
      ? { recipientId: message.recipientId, outcome: "sent", providerMessageId: id }
      : {
          recipientId: message.recipientId,
          outcome: "unknown",
          reason: "server_error",
          message: "Resend returned no id for this email.",
        };
  });
  return { results };
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

async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const call = await callProvider(ctx, `${API}/domains`, { headers: headers(credentials) });
  if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
  const { response } = call;
  if (response.ok)
    return { ok: true, account: "Full access key", warnings: [], refs: { access: "full" } };
  const body = (await readJson(response)) as ResendError | null;
  // A sending-only key can send, but it cannot create the webhook or read domains.
  if (body?.name === "restricted_api_key" && response.status === 401) {
    return {
      ok: true,
      account: "Sending access key",
      warnings: [
        "This key can only send. Envelopen cannot create the webhook, so set it up by hand, or use a Full access key.",
      ],
      refs: { access: "sending" },
    };
  }
  const classified = classifyResendError(response.status, body?.name ?? "");
  return {
    ok: false,
    reason: classified.reason,
    message:
      classified.reason === "auth"
        ? "Resend rejected the API key."
        : shortMessage(body?.message, `Resend returned ${response.status}.`),
  };
}

async function setupEvents(
  credentials: Credentials,
  target: { url: string },
  ctx: AdapterContext,
): Promise<EventsSetup> {
  if (ctx.refs.access === "sending") {
    return { mode: "manual", reason: "The API key has sending access only." };
  }
  const call = await callProvider(ctx, `${API}/webhooks`, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify({ endpoint: target.url, events: EVENTS }),
  });
  if (!call.ok) return { mode: "manual", reason: call.message };
  const body = (await readJson(call.response)) as
    | (ResendError & { id?: string; signing_secret?: string })
    | null;
  if (!call.response.ok || !body?.id || !body.signing_secret) {
    return {
      mode: "manual",
      reason: shortMessage(
        body?.message,
        `Resend did not create the webhook (${call.response.status}).`,
      ),
    };
  }
  return { mode: "auto", secret: body.signing_secret, refs: { webhookId: body.id } };
}

async function teardownEvents(credentials: Credentials, ctx: AdapterContext): Promise<void> {
  const id = ctx.refs.webhookId;
  if (!id) return;
  await callProvider(ctx, `${API}/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(credentials),
  });
}

async function domainRecords(
  credentials: Credentials,
  domain: string,
  ctx: AdapterContext,
): Promise<DnsRecordHint[] | null> {
  const list = await callProvider(ctx, `${API}/domains`, { headers: headers(credentials) });
  if (!list.ok || !list.response.ok) return null;
  const domains = (await readJson(list.response)) as {
    data?: { id?: string; name?: string }[];
  } | null;
  const match = domains?.data?.find((item) => item.name?.toLowerCase() === domain);
  if (!match?.id) return null;
  const one = await callProvider(ctx, `${API}/domains/${encodeURIComponent(match.id)}`, {
    headers: headers(credentials),
  });
  if (!one.ok || !one.response.ok) return null;
  const detail = (await readJson(one.response)) as {
    records?: { record?: string; name?: string; type?: string; value?: string }[];
  } | null;
  const records: DnsRecordHint[] = [];
  for (const record of detail?.records ?? []) {
    if (!record.type || !record.value) continue;
    const host = record.name ? `${record.name}.${domain}` : domain;
    if (record.record === "DKIM") {
      records.push({
        purpose: "dkim",
        type: record.type as DnsRecordHint["type"],
        host,
        value: record.value,
      });
    } else if (record.record === "SPF" && record.type === "TXT") {
      records.push({ purpose: "spf", type: "TXT", host, value: record.value });
    } else if (record.record === "SPF" && record.type === "MX") {
      records.push({ purpose: "return_path", type: "MX", host, value: record.value });
    }
  }
  return records.length > 0 ? records : null;
}

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    created_at?: string;
    bounce?: { type?: string; subType?: string };
    failed?: { reason?: string };
  };
}

const TYPES: Record<string, ProviderEventType> = {
  "email.delivered": "delivered",
  "email.complained": "complaint",
  "email.failed": "failed",
};

export const resendAdapter: ProviderAdapter = {
  id: "resend",
  name: "Resend",
  policy: "campaign",
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "re_...",
      pattern: "^re_[A-Za-z0-9_]+$",
      hint: "A Full access key lets Envelopen create the webhook for you.",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: true,
    idempotencyWindowMs: DAY_MS,
    rateUnit: "request",
    eventTypes: ["delivered", "bounce_hard", "bounce_soft", "complaint", "failed"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: 10,
    requiresWorkersPaid: false,
    notes: [
      "The default rate limit is 10 requests per second per team, and each batch is one request.",
      "Idempotency keys last 24 hours, so an uncertain batch can retry safely within that window.",
    ],
    docsUrl: "https://resend.com/docs/api-reference/emails/send-batch-emails",
  },
  dns: {
    spfInclude: "amazonses.com",
    spfHost: (domain) => `send.${domain}`,
    dkimSelectors: ["resend"],
  },

  manualSecret: "provider",

  connect,
  sendBatch,
  setupEvents,
  teardownEvents,
  domainRecords,

  verifyWebhook(request, secret, ctx) {
    return verifySvix(secret, svixHeaders(request.headers), request.body, (ctx.now ?? Date.now)());
  },

  parseEvents(request) {
    let event: ResendEvent;
    try {
      event = JSON.parse(request.body) as ResendEvent;
    } catch {
      return { events: [] };
    }
    let type: ProviderEventType | undefined = TYPES[event.type ?? ""];
    if (event.type === "email.bounced") {
      type = event.data?.bounce?.type === "Permanent" ? "bounce_hard" : "bounce_soft";
    }
    if (!type) return { events: [] };
    const recipients = Array.isArray(event.data?.to)
      ? event.data.to
      : event.data?.to
        ? [event.data.to]
        : [];
    const at = Date.parse(event.created_at ?? event.data?.created_at ?? "");
    const occurredAt = Number.isNaN(at) ? Date.now() : at;
    const deliveryId = svixHeaders(request.headers).id ?? `${event.data?.email_id}:${event.type}`;
    const detail = event.data?.bounce?.subType ?? event.data?.failed?.reason;
    const events: NormalizedEvent[] = recipients.map((email) => ({
      type: type as ProviderEventType,
      eventId: `${deliveryId}:${email.toLowerCase()}`,
      providerMessageId: event.data?.email_id ?? null,
      email,
      occurredAt,
      ...(detail ? { detail } : {}),
    }));
    return { events };
  },

  manualSteps(target) {
    return [
      "In the Resend dashboard, open Webhooks and choose Add Webhook.",
      `Paste this endpoint URL: ${target.url}`,
      "Select the events email.delivered, email.bounced, email.complained, and email.failed.",
      "Copy the signing secret (it starts with whsec_) and paste it into Envelopen.",
    ];
  },
};
