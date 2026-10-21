import {
  adapterContext,
  type BatchPointer,
  type BatchResults,
  campaignAudience,
  checkBatchRecipients,
  claimBatch,
  customFieldValues,
  DEFAULT_RETRY_DELAY_MS,
  decryptCredentials,
  type FrozenSet,
  LEASE_MS,
  loadBatchContext,
  type PlatformLimit,
  parseFrozenSet,
  refsOf,
  type Services,
  systemAudit,
  transitionCampaign,
  tryFinalizeCampaign,
  writeBatchResults,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import {
  mergeTagNames,
  type PersonalizedMessage,
  personalize,
  prepareMessage,
  RESERVED_TAGS,
  STANDARD_FIELDS,
  type TokenSigner,
} from "@envelopen/email-render";
import {
  type FailureReason,
  getAdapter,
  MessageError,
  type OutgoingMessage,
  type ProviderAdapter,
  type SendBatchResult,
  sendBatch,
} from "@envelopen/providers";
import { type Grant, type RateRule, rateLimiterFor, rateRule } from "../do/rate-limiter";
import { pendingUnsubscribedContacts, unsubscribeLedger } from "../do/unsubscribes";
import { activeLimit, usageMeter, usageSink } from "../do/usage";
import { createServices, tokenSigner } from "../services";

// The send-queue consumer (KTD17 to KTD21, KTD25). The queue delivers one batch pointer
// per invocation (`max_batch_size` 1). For each pointer:
//
// 1. The platform_limit flag (UsageMeter): while D1 rejects writes, drop the message.
//    The cron dispatches every waiting batch after 00:00 UTC. The same call says whether
//    the UnsubscribeLedger holds unsubscribes that D1 does not have yet (KTD1).
// 2. Load the batch and the campaign. Drop the message, with no write, when the
//    generation is stale, the batch is not enqueued, or the campaign does not send.
// 3. On the first claim, the send-time check builds the frozen recipient set. While the
//    ledger holds unsubscribes, it skips those contacts as `unsubscribed`. A retry of an
//    idempotent provider reuses the stored set: the provider may have it already, and a
//    changed payload under the same key fails.
// 4. Reserve rate tokens. A long wait retries the message later, with no write.
// 5. Claim with a compare-and-set. A second delivery of the message loses here, so two
//    messages for one batch make one provider call.
// 6. Personalize and send through the adapter.
// 7. Write the results in one atomic batch, guarded by the generation:
//    - every recipient has a result: the batch is done, and the campaign may finish;
//    - the provider refused (429, quota, credits, auth): nothing went out for the rest,
//      so the batch returns to pending, and quota, credits, or auth pause the campaign.
//      After an earlier attempt with the stored key, the batch keeps the set and the key;
//    - some results are unknown: the batch stays claimed. When the lease expires, the
//      sweep retries an idempotent provider and marks any other batch uncertain (R38).
//
// Budget per invocation on Free (KTD20): at most 12 D1 queries (13 while the ledger
// holds unsubscribes), 3 Durable Object calls (4 while it does),
// and one provider request per recipient for SES (25) or one per batch otherwise.

/** The longest a consumer waits for rate tokens before it retries the message instead. */
export const MAX_RATE_WAIT_MS = 30_000;
/** The delay of a message retry after an unexpected error. */
const ERROR_RETRY_SECONDS = 30;

/** Failures that mean nothing went out, and the batch can go again later. */
const REFUSALS: ReadonlySet<FailureReason> = new Set(["rate_limited", "quota", "credits", "auth"]);

export interface RateLimiterClient {
  acquire(units: number, rule: RateRule, maxWaitMs: number): Promise<Grant>;
  backoff(retryAfterMs: number): Promise<void>;
}

export interface ConsumerDeps {
  db: DbConnection;
  services: Pick<Services, "credentials" | "outboundFetch">;
  signer: TokenSigner;
  usage: {
    /** The platform_limit flag in force, and the ledger flag. One UsageMeter call. */
    gate(): Promise<UsageGate>;
    setPlatformLimit(since: number, until: number): Promise<unknown>;
  };
  /** The contacts with an unsubscribe in the UnsubscribeLedger (KTD1). */
  pendingUnsubscribes(
    db: DbConnection,
    workspaceId: number,
    contactIds: readonly number[],
  ): Promise<Set<number>>;
  rateLimiter(connectionId: number): RateLimiterClient;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface UsageGate {
  limit: PlatformLimit | null;
  unsubscribesPending: boolean;
}

export type ConsumerOutcome =
  | { action: "ack"; result: string }
  | { action: "retry"; delaySeconds: number; result: string };

const ack = (result: string): ConsumerOutcome => ({ action: "ack", result });

function isPointer(body: unknown): body is BatchPointer {
  const value = body as Partial<BatchPointer> | null;
  return (
    value?.v === 1 &&
    Number.isSafeInteger(value.workspaceId) &&
    Number.isSafeInteger(value.campaignId) &&
    Number.isSafeInteger(value.batchId) &&
    Number.isSafeInteger(value.generation)
  );
}

/** Merge fields that the content uses beyond the standard and reserved ones. */
function customKeys(html: string, subject: string, text: string): string[] {
  const known = new Set<string>([...STANDARD_FIELDS, ...RESERVED_TAGS]);
  return [...new Set(mergeTagNames(`${subject} ${html} ${text}`))].filter(
    (name) => !known.has(name) && !name.startsWith("@"),
  );
}

function mailbox(name: string | null, email: string): string {
  const clean = name?.replaceAll(/["<>\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
}

async function pauseCampaign(
  deps: ConsumerDeps,
  pointer: BatchPointer,
  reason: "manual" | "provider_quota" | "provider_credits",
  detail: string,
) {
  const now = deps.now();
  const changed = await transitionCampaign(
    deps.db,
    pointer.workspaceId,
    pointer.campaignId,
    ["sending"],
    "paused",
    now,
    {
      pause_reason: reason,
      pause_detail: detail.slice(0, 300),
      paused_at: now,
    },
  );
  if (changed) {
    await systemAudit(deps.db, pointer.workspaceId, pointer.campaignId, "campaigns.paused", {
      reason,
      detail,
    });
  }
}

/** Builds the frozen set from the send-time check (KTD21). */
async function freeze(
  deps: ConsumerDeps,
  pointer: BatchPointer,
  campaign: NonNullable<Awaited<ReturnType<typeof loadBatchContext>>>["campaign"],
  unsubscribesPending: boolean,
): Promise<FrozenSet> {
  let checked = await checkBatchRecipients(
    deps.db,
    pointer.workspaceId,
    pointer.campaignId,
    pointer.batchId,
    campaignAudience(campaign),
    campaign.type,
  );
  if (unsubscribesPending) {
    const waiting = await deps.pendingUnsubscribes(
      deps.db,
      pointer.workspaceId,
      checked.flatMap((row) => (row.skipReason === null && row.contactId ? [row.contactId] : [])),
    );
    checked = checked.map((row) =>
      row.contactId !== null && waiting.has(row.contactId)
        ? { ...row, skipReason: "unsubscribed" }
        : row,
    );
  }
  const sendable = checked.filter((row) => row.skipReason === null && row.email && row.contactId);
  const keys = customKeys(campaign.html ?? "", campaign.subject ?? "", campaign.text ?? "");
  const custom = await customFieldValues(
    deps.db,
    pointer.workspaceId,
    sendable.map((row) => row.contactId as number),
    keys,
  );
  return {
    v: 1,
    origin: campaign.link_origin ?? "https://example.invalid",
    recipients: sendable.map((row) => ({
      id: row.recipientId,
      email: row.email as string,
      fields: {
        ...Object.fromEntries(keys.map((key) => [key, null])),
        ...custom.get(row.contactId as number),
        email: row.email,
        first_name: row.firstName,
        last_name: row.lastName,
      },
    })),
    skipped: checked
      .filter((row) => !sendable.includes(row))
      .map((row) => ({ id: row.recipientId, reason: row.skipReason ?? "invalid" })),
  };
}

function rateFor(adapter: ProviderAdapter, refs: Readonly<Record<string, string>>): RateRule {
  const own = Number(refs.maxSendRate);
  return rateRule(Number.isFinite(own) && own > 0 ? own : adapter.facts.ratePerSecond);
}

/** Processes one pointer. Every path that drops a message returns before any write. */
export async function processPointer(deps: ConsumerDeps, body: unknown): Promise<ConsumerOutcome> {
  if (!isPointer(body)) return ack("invalid");
  const pointer = body;
  const start = deps.now();
  const gate = await deps.usage.gate();
  if (gate.limit && gate.limit.until > start) return ack("platform_limit");

  try {
    return await handlePointer(deps, pointer, gate.unsubscribesPending);
  } catch (error) {
    if (isD1DailyLimitError(error)) {
      const now = deps.now();
      await deps.usage.setPlatformLimit(now, nextUtcMidnight(now));
      return ack("platform_limit");
    }
    throw error;
  }
}

async function handlePointer(
  deps: ConsumerDeps,
  pointer: BatchPointer,
  unsubscribesPending: boolean,
): Promise<ConsumerOutcome> {
  const context = await loadBatchContext(deps.db, pointer);
  if (!context) return ack("missing");
  const { batch, campaign, connection } = context;
  if (campaign.status !== "sending") return ack("inactive");
  if (batch.generation !== pointer.generation) return ack("stale");
  if (batch.status !== "enqueued") return ack("not_enqueued");

  const adapter = connection ? getAdapter(connection.provider) : undefined;
  if (!connection || !adapter || connection.status !== "active") {
    await pauseCampaign(
      deps,
      pointer,
      "manual",
      connection?.status_detail ?? "The provider connection is not active. Check it, then resume.",
    );
    return ack("connection");
  }

  // A retry of an idempotent provider sends the stored set again, with no second check.
  const stored = parseFrozenSet(batch.recipient_set);
  const frozen = stored ?? (await freeze(deps, pointer, campaign, unsubscribesPending));
  const refs = refsOf(connection);
  const units =
    adapter.capabilities.rateUnit === "recipient"
      ? frozen.recipients.length
      : Math.ceil(frozen.recipients.length / adapter.capabilities.batchSize);
  if (units > 0) {
    const grant = await deps
      .rateLimiter(connection.id)
      .acquire(units, rateFor(adapter, refs), MAX_RATE_WAIT_MS);
    if (!grant.granted) {
      return {
        action: "retry",
        delaySeconds: Math.ceil(grant.retryAfterMs / 1000),
        result: "rate_wait",
      };
    }
    if (grant.waitMs > 0) await deps.sleep(grant.waitMs);
  }

  const now = deps.now();
  const claim = await claimBatch(
    deps.db,
    pointer,
    {
      frozen: stored ? null : frozen,
      idempotencyKey: adapter.capabilities.idempotency
        ? `envelopen-${pointer.campaignId}-${pointer.batchId}-${crypto.randomUUID()}`
        : null,
      leaseUntil: now + LEASE_MS,
    },
    now,
  );
  if (!claim) return ack("duplicate");
  const set = claim.frozen;

  if (set.recipients.length === 0) {
    await writeBatchResults(
      deps.db,
      pointer,
      { sent: [], failed: [], skipped: set.skipped, status: "done" },
      deps.now(),
    );
    await finish(deps, pointer);
    return ack("done");
  }

  const prepared = prepareMessage({
    html: campaign.html ?? "",
    subject: campaign.subject ?? "",
    text: campaign.text,
    trackingOrigin: set.origin,
    // The tracking fixed at confirm. Without it, the switches as they are now.
    trackOpens:
      campaign.send_tracking_opens !== null
        ? campaign.send_tracking_opens === 1
        : campaign.tracking_opens === 1 && campaign.ws_tracking_opens === 1,
    trackClicks:
      campaign.send_tracking_clicks !== null
        ? campaign.send_tracking_clicks === 1
        : campaign.tracking_clicks === 1 && campaign.ws_tracking_clicks === 1,
  });
  const from = mailbox(campaign.from_name, campaign.from_email ?? "");
  const messages: OutgoingMessage[] = [];
  for (const recipient of set.recipients) {
    const personal: PersonalizedMessage = await personalize(
      prepared,
      { campaignId: pointer.campaignId, recipientId: recipient.id, fields: recipient.fields },
      deps.signer,
    );
    messages.push({
      recipientId: String(recipient.id),
      kind: "campaign",
      from,
      to: recipient.email,
      ...(campaign.reply_to ? { replyTo: campaign.reply_to } : {}),
      subject: personal.subject,
      html: personal.html,
      ...(personal.text ? { text: personal.text } : {}),
      headers: personal.headers,
    });
  }

  let result: SendBatchResult;
  try {
    result = await sendBatch(
      adapter,
      messages,
      await decryptCredentials(deps.services, connection),
      {
        ...adapterContext(deps.services, refs),
        ...(claim.idempotencyKey ? { idempotencyKey: claim.idempotencyKey } : {}),
      },
    );
  } catch (error) {
    // A message that breaks the contract never reached the provider.
    if (!(error instanceof MessageError)) throw error;
    await writeBatchResults(
      deps.db,
      pointer,
      {
        sent: [],
        failed: set.recipients.map((recipient) => ({ id: recipient.id, error: error.message })),
        skipped: set.skipped,
        status: "done",
        error: error.message,
      },
      deps.now(),
    );
    await finish(deps, pointer);
    return ack("invalid_message");
  }

  const results: BatchResults = {
    sent: [],
    failed: [],
    skipped: set.skipped,
    status: "done",
    links: prepared.links,
  };
  let unknown = 0;
  let refused: FailureReason | null = null;
  let refusal = "";
  for (const item of result.results) {
    const id = Number(item.recipientId);
    if (item.outcome === "sent")
      results.sent.push({ id, providerMessageId: item.providerMessageId ?? null });
    else if (item.outcome === "unknown") unknown++;
    else if (item.reason && REFUSALS.has(item.reason)) {
      refused ??= item.reason;
      refusal ||= item.message ?? "";
    } else results.failed.push({ id, error: item.message ?? item.reason ?? "Not sent." });
  }

  if (unknown > 0) {
    // An idempotent retry must send the same payload, so it records nothing yet.
    if (adapter.capabilities.idempotency) return ack("unknown");
    await writeBatchResults(
      deps.db,
      pointer,
      {
        ...results,
        status: "claimed",
        error: result.failure?.message ?? "Some results are unknown.",
      },
      deps.now(),
    );
    return ack("unknown");
  }

  if (refused) {
    const retryAfter = result.failure?.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
    const message = result.failure?.message || refusal || "The provider refused the batch.";
    // This attempt sent nothing, but an earlier attempt with the stored key may have
    // (an unknown result, then a lease retry). The batch then keeps the set and the key.
    const keepSet = stored !== null && batch.idempotency_key !== null;
    await writeBatchResults(
      deps.db,
      pointer,
      {
        ...results,
        status: "pending",
        notBefore: deps.now() + retryAfter,
        error: message,
        keepSet,
      },
      deps.now(),
    );
    if (refused === "rate_limited") await deps.rateLimiter(connection.id).backoff(retryAfter);
    else if (refused === "quota") await pauseCampaign(deps, pointer, "provider_quota", message);
    else if (refused === "credits") await pauseCampaign(deps, pointer, "provider_credits", message);
    else
      await pauseCampaign(
        deps,
        pointer,
        "manual",
        `The provider rejected the credentials: ${message}`,
      );
    return ack("returned");
  }

  const written = await writeBatchResults(deps.db, pointer, results, deps.now());
  if (written) await finish(deps, pointer);
  return ack(written ? "sent" : "stale_result");
}

/** The consumer tries to finish the campaign after each batch (KTD19). */
async function finish(deps: ConsumerDeps, pointer: BatchPointer) {
  const result = await tryFinalizeCampaign(
    deps.db,
    pointer.workspaceId,
    pointer.campaignId,
    deps.now(),
  );
  if (result.changed && result.status) {
    await systemAudit(
      deps.db,
      pointer.workspaceId,
      pointer.campaignId,
      `campaigns.${result.status}`,
      {
        by: "consumer",
      },
    );
  }
}

/** The consumer's dependencies from the Worker's bindings. */
export async function consumerDeps(env: Env, db: DbConnection): Promise<ConsumerDeps> {
  const services = createServices(env);
  if (!services.credentials) throw new Error("ENCRYPTION_KEY is missing.");
  const meter = usageMeter(env);
  return {
    db,
    services: { credentials: services.credentials, outboundFetch: services.outboundFetch ?? fetch },
    signer: await tokenSigner(env),
    usage: {
      gate: async () => {
        const status = await meter.status();
        return {
          limit: activeLimit(status, Date.now()),
          unsubscribesPending: status.unsubscribesPending === true,
        };
      },
      setPlatformLimit: (since, until) => meter.setPlatformLimit(since, until),
    },
    pendingUnsubscribes: (db, workspaceId, contactIds) =>
      pendingUnsubscribedContacts(unsubscribeLedger(env), db, workspaceId, contactIds),
    rateLimiter: (connectionId) => {
      const stub = rateLimiterFor(env, connectionId);
      return {
        acquire: (units, rule, maxWaitMs) => stub.acquire(units, rule, maxWaitMs),
        backoff: (ms) => stub.backoff(ms),
      };
    },
    sleep: (ms) => scheduler.wait(ms),
    now: () => Date.now(),
  };
}

/** The `queue()` handler. Tests pass their own dependencies. */
export async function handleSendBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  makeDeps: (db: DbConnection) => Promise<ConsumerDeps> = (db) => consumerDeps(env, db),
): Promise<void> {
  const db = createDb(env, { usageSink: usageSink(env) });
  const deps = await makeDeps(db);
  for (const message of batch.messages) {
    try {
      const outcome = await processPointer(deps, message.body);
      if (outcome.action === "retry") message.retry({ delaySeconds: outcome.delaySeconds });
      else message.ack();
    } catch (error) {
      console.error("Send consumer error", message.body, error);
      message.retry({ delaySeconds: ERROR_RETRY_SECONDS });
    }
  }
  // KTD24: report the rows written once per invocation. The handler awaits it: the
  // invocation is over once the handler returns.
  await db.meter.flush().catch((error) => console.error("Usage report failed", error));
}
