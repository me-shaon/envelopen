import { bytesToBase64, timingSafeEqual, utf8 } from "../shared/encoding";
import { callProvider, readJson, retryAfterMs, shortMessage } from "../shared/http";
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

// Postmark through a Broadcast message stream (KTD16). Postmark allows bulk email only
// on a Broadcast stream, and the batch endpoint takes the stream per message.
// https://postmarkapp.com/support/article/can-i-send-bulk-emails
// https://postmarkapp.com/developer/api/email-api
// https://postmarkapp.com/developer/api/webhooks-api
//
// Two facts shape this adapter:
// - Postmark does not sign webhooks. Envelopen sets HTTP Basic auth on the webhook,
//   with a random password, and checks it on every request.
// - On a stream where Postmark manages unsubscribes, Postmark replaces the
//   List-Unsubscribe headers with its own. Envelopen's headers pass through only after
//   Postmark support turns on custom unsubscribe handling. `connect` warns about it.

const API = "https://api.postmarkapp.com";
const BATCH_SIZE = 50;
const WEBHOOK_USER = "envelopen";

function headers(credentials: Credentials) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-postmark-server-token": credentials.serverToken ?? "",
  };
}

interface PostmarkError {
  ErrorCode?: number;
  Message?: string;
}

/** Maps a Postmark error to the classes of KTD12. https://postmarkapp.com/developer/api/overview */
export function classifyPostmarkError(
  status: number,
  code: number,
): { outcome: "not_sent" | "unknown"; reason: FailureReason; stop: boolean } {
  if (status >= 500) return { outcome: "unknown", reason: "server_error", stop: true };
  if (status === 429) return { outcome: "not_sent", reason: "rate_limited", stop: true };
  if (status === 401 || code === 10) return { outcome: "not_sent", reason: "auth", stop: true };
  switch (code) {
    // The account is pending approval, or not approved to send.
    case 412:
    case 413:
      return { outcome: "not_sent", reason: "auth", stop: true };
    // Historically "out of credits". Not in the current list of codes.
    case 405:
      return { outcome: "not_sent", reason: "credits", stop: true };
    case 406:
      return { outcome: "not_sent", reason: "rejected", stop: false };
    case 1235:
    case 1236:
      return { outcome: "not_sent", reason: "validation", stop: true };
    default:
      return { outcome: "not_sent", reason: "validation", stop: false };
  }
}

function payload(message: OutgoingMessage, stream: string) {
  return {
    From: message.from,
    To: message.to,
    Subject: message.subject,
    HtmlBody: message.html,
    ...(message.text ? { TextBody: message.text } : {}),
    ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
    Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
    MessageStream: stream,
    // Envelopen tracks opens and clicks itself (KTD26).
    TrackOpens: false,
    TrackLinks: "None",
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
  const stream = ctx.refs.messageStream ?? credentials.messageStream ?? "broadcast";
  const call = await callProvider(ctx, `${API}/email/batch`, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify(messages.map((message) => payload(message, stream))),
  });
  if (!call.ok) {
    return everyone(messages, { outcome: "unknown", reason: call.reason, message: call.message });
  }
  const { response } = call;
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body)) {
    const error = (body ?? {}) as PostmarkError;
    const classified = classifyPostmarkError(response.status, error.ErrorCode ?? 0);
    const retry = retryAfterMs(response);
    return everyone(messages, {
      outcome: classified.outcome,
      reason: classified.reason,
      message: shortMessage(error.Message, `Postmark returned ${response.status}.`),
      status: response.status,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    });
  }
  // A batch answers 200 even when some messages fail. Each item has its ErrorCode.
  const items = body as (PostmarkError & { MessageID?: string })[];
  let failure: BatchFailure | undefined;
  const results: RecipientResult[] = messages.map((message, index) => {
    const item = items[index];
    if (!item) {
      return {
        recipientId: message.recipientId,
        outcome: "unknown",
        reason: "server_error",
        message: "Postmark returned no result for this email.",
      };
    }
    if (item.ErrorCode === 0 && item.MessageID) {
      return {
        recipientId: message.recipientId,
        outcome: "sent",
        providerMessageId: item.MessageID,
      };
    }
    const classified = classifyPostmarkError(422, item.ErrorCode ?? 0);
    const text = shortMessage(item.Message, `Postmark error ${item.ErrorCode}.`);
    if (classified.stop && !failure) {
      failure = { outcome: classified.outcome, reason: classified.reason, message: text };
    }
    return {
      recipientId: message.recipientId,
      outcome: classified.outcome,
      reason: classified.reason,
      message: text,
    };
  });
  return failure ? { results, failure } : { results };
}

interface MessageStream {
  ID?: string;
  Name?: string;
  MessageStreamType?: string;
  ArchivedAt?: string | null;
  SubscriptionManagementConfiguration?: { UnsubscribeHandlingType?: string };
}

async function connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck> {
  const server = await callProvider(ctx, `${API}/server`, { headers: headers(credentials) });
  if (!server.ok) return { ok: false, reason: server.reason, message: server.message };
  if (!server.response.ok) {
    const error = ((await readJson(server.response)) ?? {}) as PostmarkError;
    const classified = classifyPostmarkError(server.response.status, error.ErrorCode ?? 0);
    return {
      ok: false,
      reason: classified.reason,
      message:
        classified.reason === "auth"
          ? "Postmark rejected the server token."
          : shortMessage(error.Message, `Postmark returned ${server.response.status}.`),
    };
  }
  const info = (await readJson(server.response)) as { Name?: string } | null;

  const streams = await callProvider(ctx, `${API}/message-streams?MessageStreamType=Broadcasts`, {
    headers: headers(credentials),
  });
  if (!streams.ok) return { ok: false, reason: streams.reason, message: streams.message };
  const list = ((await readJson(streams.response)) as { MessageStreams?: MessageStream[] } | null)
    ?.MessageStreams;
  const wanted = credentials.messageStream?.trim();
  const broadcast = (list ?? []).find(
    (stream) =>
      stream.MessageStreamType === "Broadcasts" &&
      !stream.ArchivedAt &&
      (wanted ? stream.ID === wanted : true),
  );
  if (!broadcast?.ID) {
    return {
      ok: false,
      reason: "validation",
      message: wanted
        ? `This server has no Broadcast stream with the ID ${wanted}.`
        : "This server has no Broadcast message stream. Create one in Postmark: bulk email must use a Broadcast stream.",
    };
  }
  const warnings: string[] = [];
  if (broadcast.SubscriptionManagementConfiguration?.UnsubscribeHandlingType !== "Custom") {
    warnings.push(
      "Postmark manages unsubscribes on this stream and replaces Envelopen's List-Unsubscribe headers. Ask Postmark support to turn on custom unsubscribe handling for the stream.",
    );
  }
  return {
    ok: true,
    account: `${info?.Name ?? "Server"}, stream ${broadcast.ID}`,
    warnings,
    refs: { messageStream: broadcast.ID },
  };
}

async function setupEvents(
  credentials: Credentials,
  target: { url: string; secret: string },
  ctx: AdapterContext,
): Promise<EventsSetup> {
  const call = await callProvider(ctx, `${API}/webhooks`, {
    method: "POST",
    headers: headers(credentials),
    body: JSON.stringify({
      Url: target.url,
      MessageStream: ctx.refs.messageStream ?? "broadcast",
      HttpAuth: { Username: WEBHOOK_USER, Password: target.secret },
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: false },
        SpamComplaint: { Enabled: true, IncludeContent: false },
      },
    }),
  });
  if (!call.ok) return { mode: "manual", reason: call.message };
  const body = (await readJson(call.response)) as (PostmarkError & { ID?: number }) | null;
  if (!call.response.ok || typeof body?.ID !== "number") {
    return {
      mode: "manual",
      reason: shortMessage(
        body?.Message,
        `Postmark did not create the webhook (${call.response.status}).`,
      ),
    };
  }
  return { mode: "auto", secret: target.secret, refs: { webhookId: String(body.ID) } };
}

async function teardownEvents(credentials: Credentials, ctx: AdapterContext): Promise<void> {
  const id = ctx.refs.webhookId;
  if (!id) return;
  await callProvider(ctx, `${API}/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(credentials),
  });
}

/** The Authorization header that Postmark sends for the webhook secret. */
export function postmarkAuthorization(secret: string): string {
  return `Basic ${bytesToBase64(utf8(`${WEBHOOK_USER}:${secret}`))}`;
}

interface PostmarkEvent {
  RecordType?: string;
  ID?: number;
  Type?: string;
  TypeCode?: number;
  MessageID?: string;
  Email?: string;
  Recipient?: string;
  DeliveredAt?: string;
  BouncedAt?: string;
}

/** Bounce types that mean the address does not work. https://postmarkapp.com/developer/api/bounce-api */
const HARD_BOUNCES = new Set([1, 100000, 100006]);
/** Bounce types that may work later. Others (auto-responders, subscribe notices) are not bounces. */
const SOFT_BOUNCES = new Set([2, 256, 4096]);

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export const postmarkAdapter: ProviderAdapter = {
  id: "postmark",
  name: "Postmark",
  policy: "campaign",
  credentialFields: [
    {
      name: "serverToken",
      label: "Server API token",
      secret: true,
      required: true,
      hint: "From the API Tokens tab of the Postmark server that has your Broadcast stream.",
    },
    {
      name: "messageStream",
      label: "Broadcast stream ID",
      secret: false,
      required: false,
      placeholder: "broadcast",
      hint: "Leave empty to use the first Broadcast stream of the server.",
      pattern: "^[a-z0-9-]{1,30}$",
    },
  ],
  capabilities: {
    batchSize: BATCH_SIZE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "request",
    eventTypes: ["delivered", "bounce_hard", "bounce_soft", "complaint"],
    customHeaders: true,
    autoWebhook: true,
  },
  facts: {
    ratePerSecond: 10,
    requiresWorkersPaid: false,
    notes: [
      "Bulk email must go through a Broadcast message stream.",
      "Postmark publishes no request rate. Envelopen starts at 10 batch requests per second and backs off on 429.",
      "Custom List-Unsubscribe headers need custom unsubscribe handling, which Postmark support turns on.",
    ],
    docsUrl: "https://postmarkapp.com/developer/api/email-api",
  },
  dns: {
    spfInclude: "spf.mtasv.net",
    spfHost: (domain) => `pm-bounces.${domain}`,
    dkimSelectors: [],
  },
  manualSecret: "envelopen",

  connect,
  sendBatch,
  setupEvents,
  teardownEvents,

  async verifyWebhook(request, secret) {
    const header = request.headers.get("authorization") ?? "";
    if (!secret || !timingSafeEqual(header, postmarkAuthorization(secret))) {
      return { ok: false, reason: "Wrong or missing Basic auth." };
    }
    return { ok: true };
  },

  parseEvents(request) {
    let event: PostmarkEvent;
    try {
      event = JSON.parse(request.body) as PostmarkEvent;
    } catch {
      return { events: [] };
    }
    const trace = request.headers.get("x-pm-webhook-trace-id");
    // Bounce ids are 64-bit integers, beyond the safe range of a JS number. Read the
    // digits from the raw body, so two bounces never share a rounded id.
    const rawId = /"ID"\s*:\s*(\d+)/.exec(request.body)?.[1] ?? event.ID ?? trace;
    const base = {
      providerMessageId: event.MessageID ?? null,
    };
    const events: NormalizedEvent[] = [];
    if (event.RecordType === "Delivery" && event.Recipient) {
      events.push({
        ...base,
        type: "delivered",
        eventId: `delivery:${event.MessageID}:${event.Recipient.toLowerCase()}`,
        email: event.Recipient,
        occurredAt: time(event.DeliveredAt),
      });
    } else if (event.RecordType === "Bounce" && event.Email) {
      const code = event.TypeCode ?? 0;
      const type = HARD_BOUNCES.has(code)
        ? "bounce_hard"
        : SOFT_BOUNCES.has(code)
          ? "bounce_soft"
          : null;
      if (type) {
        events.push({
          ...base,
          type,
          eventId: `bounce:${rawId}`,
          email: event.Email,
          occurredAt: time(event.BouncedAt),
          ...(event.Type ? { detail: event.Type } : {}),
        });
      }
    } else if (event.RecordType === "SpamComplaint" && event.Email) {
      events.push({
        ...base,
        type: "complaint",
        eventId: `complaint:${rawId}`,
        email: event.Email,
        occurredAt: time(event.BouncedAt),
      });
    }
    return { events };
  },

  manualSteps(target) {
    return [
      "In Postmark, open the server, then the Broadcast stream, then Webhooks, and choose Add webhook.",
      `Paste this URL: ${target.url}`,
      `Turn on Basic auth credentials. Username: ${WEBHOOK_USER}. Password: the webhook secret below.`,
      "Select Delivery, Bounce, and Spam complaint, and save.",
    ];
  },
};
