import { bytesToHex, hmacSha256, timingSafeEqual, utf8 } from "../../../src/shared/encoding";
import {
  callProvider,
  classifyStatus,
  failBatch,
  readJson,
  retryAfterMs,
  shortMessage,
  transportFailure,
} from "../../../src/shared/http";
import type {
  AdapterContext,
  BatchFailure,
  Credentials,
  FailureReason,
  NormalizedEvent,
  OutgoingMessage,
  ProviderAdapter,
  ProviderEventType,
  RecipientResult,
  WebhookRequest,
} from "../../../src/types";

// Lettermill is a fictional provider. This adapter exists only to test the adapter
// authoring guide against the conformance kit. It is not in ADAPTERS.

const API = "https://api.lettermill.example";
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

interface LettermillError {
  error?: { code?: string; message?: string };
}

interface LettermillItem {
  status?: string;
  id?: string;
  code?: string;
  message?: string;
}

function headers(credentials: Credentials): Record<string, string> {
  return { "X-Lettermill-Key": credentials.apiKey ?? "", "Content-Type": "application/json" };
}

function errorOf(body: unknown): { code?: string; message?: string } {
  return (body as LettermillError | null)?.error ?? {};
}

function now(ctx: AdapterContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

/** Signs `timestamp.body` the way Lettermill does. The fixtures reuse it. */
export async function lettermillSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `v1=${bytesToHex(await hmacSha256(utf8(secret), `${timestamp}.${body}`))}`;
}

function itemResult(message: OutgoingMessage, item: LettermillItem | undefined): RecipientResult {
  if (item?.status === "accepted" && item.id) {
    return { recipientId: message.recipientId, outcome: "sent", providerMessageId: item.id };
  }
  if (!item) {
    return {
      recipientId: message.recipientId,
      outcome: "unknown",
      reason: "server_error",
      message: "Lettermill returned no result for this recipient.",
    };
  }
  const reason: FailureReason = item.code === "invalid_recipient" ? "validation" : "rejected";
  return {
    recipientId: message.recipientId,
    outcome: "not_sent",
    reason,
    message: shortMessage(item.message, "Lettermill rejected the message."),
  };
}

const EVENT_TYPES: Record<string, (bounceKind: unknown) => ProviderEventType> = {
  "message.delivered": () => "delivered",
  "message.bounced": (kind) => (kind === "soft" ? "bounce_soft" : "bounce_hard"),
  "message.complained": () => "complaint",
};

export const lettermillAdapter: ProviderAdapter = {
  id: "lettermill",
  name: "Lettermill",
  policy: "campaign",
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "lm_live_...",
      pattern: "^lm_live_[A-Za-z0-9]+$",
    },
  ],
  capabilities: {
    batchSize: 50,
    idempotency: true,
    idempotencyWindowMs: 12 * 60 * 60 * 1000,
    rateUnit: "request",
    eventTypes: ["delivered", "bounce_hard", "bounce_soft", "complaint"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: 20,
    requiresWorkersPaid: false,
    notes: [
      "Lettermill accepts up to 100 messages in one batch request.",
      "Lettermill allows 20 API requests per second.",
      "Lettermill keeps an idempotency key for 12 hours.",
    ],
    docsUrl: "https://api.lettermill.example/docs",
  },
  dns: { spfInclude: "spf.lettermill.example", dkimSelectors: ["lm"] },
  manualSecret: "provider",

  async connect(credentials, ctx) {
    const call = await callProvider(ctx, `${API}/v1/account`, { headers: headers(credentials) });
    if (!call.ok) return { ok: false, reason: call.reason, message: call.message };
    const body = await readJson(call.response);
    if (!call.response.ok) {
      return {
        ok: false,
        reason: classifyStatus(call.response.status).reason,
        message: shortMessage(errorOf(body).message, "Lettermill refused the request."),
      };
    }
    const account = (body as { account?: { name?: string; plan?: string } } | null)?.account;
    return {
      ok: true,
      account: account?.name ? `${account.name}, ${account.plan ?? "unknown"} plan` : null,
      warnings: [],
    };
  },

  async sendBatch(messages, credentials, ctx) {
    const payload = {
      messages: messages.map((message) => ({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo,
        headers: { ...message.headers },
      })),
    };
    const requestHeaders = headers(credentials);
    if (ctx.idempotencyKey) requestHeaders["Idempotency-Key"] = ctx.idempotencyKey;
    const call = await callProvider(ctx, `${API}/v1/messages/batch`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });
    if (!call.ok) return failBatch(messages, transportFailure(call));
    const { response } = call;
    const body = await readJson(response);

    if (response.status === 200 || response.status === 207) {
      const items = (body as { results?: LettermillItem[] } | null)?.results ?? [];
      return { results: messages.map((message, index) => itemResult(message, items[index])) };
    }

    const { outcome, reason } = classifyStatus(response.status);
    const error = errorOf(body);
    const failure: BatchFailure = {
      outcome,
      reason: error.code === "insufficient_credits" ? "credits" : reason,
      message: shortMessage(error.message, `Lettermill answered with status ${response.status}.`),
      status: response.status,
    };
    const retryAfter = retryAfterMs(response, now(ctx));
    if (retryAfter !== undefined) failure.retryAfterMs = retryAfter;
    return failBatch(messages, failure);
  },

  async verifyWebhook(request, secret, ctx) {
    if (!secret) return { ok: false, reason: "No webhook secret is set." };
    const timestamp = request.headers.get("lettermill-timestamp");
    const signature = request.headers.get("lettermill-signature");
    if (!timestamp || !signature) {
      return { ok: false, reason: "The signature headers are missing." };
    }
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return { ok: false, reason: "The timestamp is not valid." };
    if (Math.abs(now(ctx) - seconds * 1000) > SIGNATURE_WINDOW_MS) {
      return { ok: false, reason: "The timestamp is outside the 5 minute window." };
    }
    const expected = await lettermillSignature(secret, timestamp, request.body);
    if (!timingSafeEqual(expected, signature.trim())) {
      return { ok: false, reason: "The signature does not match." };
    }
    return { ok: true };
  },

  parseEvents(request: WebhookRequest) {
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return { events: [] };
    }
    const event = body as {
      id?: string;
      type?: string;
      created_at?: string;
      data?: { message_id?: string; recipient?: string; bounce_kind?: string };
    };
    const toType = event.type ? EVENT_TYPES[event.type] : undefined;
    const occurredAt = Date.parse(event.created_at ?? "");
    if (!toType || !event.id || Number.isNaN(occurredAt)) return { events: [] };
    const normalized: NormalizedEvent = {
      type: toType(event.data?.bounce_kind),
      eventId: event.id,
      providerMessageId: event.data?.message_id ?? null,
      email: event.data?.recipient ?? null,
      occurredAt,
    };
    if (event.data?.bounce_kind) normalized.detail = event.data.bounce_kind;
    return { events: [normalized] };
  },

  async setupEvents(credentials, target, ctx) {
    const call = await callProvider(ctx, `${API}/v1/webhooks`, {
      method: "POST",
      headers: headers(credentials),
      body: JSON.stringify({
        url: target.url,
        events: ["message.delivered", "message.bounced", "message.complained"],
      }),
    });
    if (!call.ok) return { mode: "manual", reason: call.message };
    const body = (await readJson(call.response)) as { id?: string; secret?: string } | null;
    if (call.response.status !== 201 || !body?.id || !body.secret) {
      return {
        mode: "manual",
        reason: shortMessage(errorOf(body).message, "Lettermill did not create the webhook."),
      };
    }
    return { mode: "auto", secret: body.secret, refs: { webhookId: body.id } };
  },

  async teardownEvents(credentials, ctx) {
    const id = ctx.refs.webhookId;
    if (!id) return;
    await callProvider(ctx, `${API}/v1/webhooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(credentials),
    });
  },

  manualSteps(target) {
    return [
      "Open the Lettermill dashboard, then Webhooks, and select Add webhook.",
      `Enter this URL: ${target.url}`,
      "Select the events message.delivered, message.bounced, and message.complained.",
      "Save the webhook, then copy the signing secret that Lettermill shows.",
      "Paste the signing secret into Envelopen.",
    ];
  },
};
