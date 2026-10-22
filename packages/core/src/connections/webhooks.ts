import type { DbConnection } from "@envelopen/db";
import {
  getAdapter,
  isSnsUrl,
  type NormalizedEvent,
  type ProviderAdapter,
  type ProviderUnsubscribe,
  type WebhookNonce,
  type WebhookRequest,
} from "@envelopen/providers";
import { normalizeEmail } from "../contacts/email";
import { chunk } from "../contacts/writes";
import type { ProviderEventRef } from "../events/model";
import { requireService, type Services } from "../services";
import { stopWelcome } from "../welcome/start";
import { adapterContext, decryptWebhookSecret, refsOf } from "./model";

// Provider webhooks (R43): verify, normalize, store. This is the hand-off to the event
// pipeline of U10 (KTD31):
//
// - Every verified event lands in `provider_events` once. The unique event id turns a
//   replayed delivery into a no-op.
// - A hard bounce or a complaint writes the suppression at once, as the event flow says.
// - The outcome lists the rows that this request added (`events`). The hook route hands
//   them to the workspace's EventBuffer Durable Object, whose flush matches them to
//   campaign recipients by `provider_message_id`, writes the raw events and rollups, and
//   sets `processed_at` (events/flush.ts). The cron hands over rows that stay
//   unprocessed, for example when that hand-off failed (events/retention.ts).
// - An unsubscribe that the provider reports (Brevo's own link, KTD13) unsubscribes the
//   contact from every list at once, with the source `provider:<id>`. It is not a
//   provider event, and a replay changes nothing.
// - A provider whose signature covers a one-time token and not the body (Mailgun) gets
//   the token recorded in `webhook_nonces` before anything else. A second request with
//   that token answers 401 and records nothing, also when its body differs.
// - `admit` caps the verified requests of one connection. The hook route passes it for
//   providers whose webhook has no signature (the Brevo bearer token).

export interface WebhookOutcome {
  /**
   * HTTP status for the provider: 200 stops its retries, 401 and 404 mean "not for us",
   * and 429 asks the provider to send it again later.
   */
  status: 200 | 401 | 404 | 429;
  received: number;
  stored: number;
  confirmedSubscription: boolean;
  /** The rows that this request added, for the event pipeline. Replays add none. */
  events: ProviderEventRef[];
}

export interface WebhookDeps {
  db: DbConnection;
  services: Partial<Services>;
  /**
   * Counts one verified request of the connection. False when the connection is over
   * its cap: the request is answered 429 and records nothing.
   */
  admit?(target: { workspaceId: number; connectionId: number }): Promise<boolean>;
}

const SUPPRESS = { bounce_hard: "hard_bounce", complaint: "complaint" } as const;

export async function receiveProviderWebhook(
  deps: WebhookDeps,
  target: { provider: string; workspaceId: number; connectionId: number },
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  const none = { received: 0, stored: 0, confirmedSubscription: false, events: [] };
  const adapter = getAdapter(target.provider);
  if (!adapter) return { status: 404, ...none };
  const row = await deps.db.db
    .selectFrom("provider_connections")
    .select([
      "id",
      "workspace_id",
      "provider",
      "provider_refs",
      "webhook_secret_encrypted",
      "credentials_key_version",
    ])
    .where("workspace_id", "=", target.workspaceId)
    .where("id", "=", target.connectionId)
    .where("provider", "=", target.provider)
    .executeTakeFirst();
  if (!row) return { status: 404, ...none };

  // Respond, record nothing (the event flow): a request that fails verification
  // changes no state.
  const secret = await decryptWebhookSecret(deps.services, row).catch(() => null);
  if (!secret) return { status: 401, ...none };
  const refs = refsOf(row);
  const verified = await adapter.verifyWebhook(
    request,
    secret,
    adapterContext(deps.services, refs),
  );
  if (!verified.ok) return { status: 401, ...none };
  if (deps.admit && !(await deps.admit({ workspaceId: row.workspace_id, connectionId: row.id }))) {
    return { status: 429, ...none };
  }

  // A provider that signs a one-time token and not the body (Mailgun): the token is
  // good once. The insert is the check, so two requests with one token cannot both pass.
  const nonce = verified.nonce;
  if (nonce && !(await claimNonce(deps, row, nonce))) return { status: 401, ...none };
  try {
    return await processVerified(deps, adapter, row, refs, request);
  } catch (error) {
    // Nothing is stored, so the provider's retry must pass. Release the token.
    if (nonce) await releaseNonce(deps, row, nonce.value).catch(() => undefined);
    throw error;
  }
}

/** Records a webhook nonce. False when the connection has seen it before. */
async function claimNonce(
  deps: WebhookDeps,
  row: { id: number; workspace_id: number },
  nonce: WebhookNonce,
): Promise<boolean> {
  const value = nonce.value.slice(0, 200);
  const result = await deps.db.db
    .insertInto("webhook_nonces")
    .values({
      workspace_id: row.workspace_id,
      connection_id: row.id,
      nonce: value,
      expires_at: nonce.expiresAt,
    })
    .onConflict((conflict) => conflict.columns(["connection_id", "nonce"]).doNothing())
    .returning("nonce")
    .executeTakeFirst();
  return result !== undefined;
}

async function releaseNonce(
  deps: WebhookDeps,
  row: { id: number; workspace_id: number },
  value: string,
): Promise<void> {
  await deps.db.db
    .deleteFrom("webhook_nonces")
    .where("workspace_id", "=", row.workspace_id)
    .where("connection_id", "=", row.id)
    .where("nonce", "=", value.slice(0, 200))
    .execute();
}

async function processVerified(
  deps: WebhookDeps,
  adapter: ProviderAdapter,
  row: { id: number; workspace_id: number },
  refs: Record<string, string>,
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  const parsed = adapter.parseEvents(request);
  let confirmedSubscription = false;
  if (parsed.confirmSubscriptionUrl) {
    confirmedSubscription = await confirmSubscription(
      deps,
      row,
      refs,
      parsed.confirmSubscriptionUrl,
    );
  }
  const events = await storeEvents(deps, row.workspace_id, row.id, adapter.id, parsed.events);
  const unsubscribes = parsed.unsubscribes ?? [];
  if (unsubscribes.length > 0) {
    await applyProviderUnsubscribes(deps, row.workspace_id, adapter.id, unsubscribes);
  }
  return {
    status: 200,
    received: parsed.events.length + unsubscribes.length,
    stored: events.length,
    confirmedSubscription,
    events,
  };
}

/** SNS: a GET of the SubscribeURL confirms the subscription. The adapter checked its host. */
async function confirmSubscription(
  deps: WebhookDeps,
  row: { id: number; workspace_id: number },
  refs: Record<string, string>,
  url: string,
): Promise<boolean> {
  const region = refs.region ?? new URL(url).hostname.split(".")[1] ?? "";
  if (!isSnsUrl(url, region)) return false;
  try {
    const response = await requireService(deps.services, "outboundFetch")(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  await deps.db.db
    .updateTable("provider_connections")
    .set({
      provider_refs: JSON.stringify({ ...refs, subscriptionConfirmedAt: String(Date.now()) }),
    })
    .where("workspace_id", "=", row.workspace_id)
    .where("id", "=", row.id)
    .execute();
  return true;
}

async function storeEvents(
  deps: WebhookDeps,
  workspaceId: number,
  connectionId: number,
  provider: string,
  events: readonly NormalizedEvent[],
): Promise<ProviderEventRef[]> {
  if (events.length === 0) return [];
  const hashEmail = requireService(deps.services, "hashEmail");
  const rows = [];
  for (const event of events.slice(0, 100)) {
    const email = event.email ? normalizeEmail(event.email) : null;
    rows.push({
      workspace_id: workspaceId,
      connection_id: connectionId,
      provider,
      event_id: event.eventId.slice(0, 300),
      type: event.type,
      provider_message_id: event.providerMessageId,
      email_hash: email ? await hashEmail(email) : null,
      detail: event.detail?.slice(0, 200) ?? null,
      occurred_at: event.occurredAt,
    });
  }
  const { db } = deps;
  // 10 columns per row keeps each insert under D1's 100 bound parameters.
  const inserts = chunk(rows, 9).map((part) =>
    db.db
      .insertInto("provider_events")
      .values(part)
      .onConflict((conflict) =>
        conflict.columns(["workspace_id", "provider", "event_id"]).doNothing(),
      )
      .returning(["id", "type", "provider_message_id", "email_hash", "occurred_at"]),
  );
  const suppressions = rows.flatMap((row) => {
    const reason = SUPPRESS[row.type as keyof typeof SUPPRESS];
    return reason && row.email_hash
      ? [
          db.db
            .insertInto("suppressions")
            .values({
              workspace_id: workspaceId,
              email_hash: row.email_hash,
              reason,
              source: `provider:${provider}`,
              campaign_id: null,
            })
            .onConflict((conflict) => conflict.columns(["workspace_id", "email_hash"]).doNothing()),
        ]
      : [];
  });
  const results = await db.atomic<{
    id: number;
    type: ProviderEventRef["type"];
    provider_message_id: string | null;
    email_hash: string | null;
    occurred_at: number;
  }>([...inserts, ...suppressions]);
  const suppressed = rows
    .filter((row) => SUPPRESS[row.type as keyof typeof SUPPRESS] && row.email_hash)
    .map((row) => row.email_hash as string);
  const newSuppressions = results
    .slice(inserts.length)
    .some((result) => (result.meta.changes ?? 0) > 0);
  if (newSuppressions && deps.services.welcome) {
    // A bounce or a complaint stops the welcome series of the contact (U10).
    const contacts = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("email_hash", "in", suppressed)
      .execute();
    await stopWelcome(
      db,
      deps.services.welcome,
      workspaceId,
      contacts.map((row) => row.id),
    );
  }
  return results.slice(0, inserts.length).flatMap((result) =>
    (result.results ?? []).map((added) => ({
      source: "provider" as const,
      id: added.id,
      type: added.type,
      providerMessageId: added.provider_message_id,
      emailHash: added.email_hash,
      occurredAt: added.occurred_at,
    })),
  );
}

/**
 * Unsubscribes the contacts behind provider unsubscribe events from every list, like a
 * one-click unsubscribe (events/subscription.ts), and stops their welcome series. A
 * contact that is unsubscribed already does not change. Returns the contacts changed.
 */
export async function applyProviderUnsubscribes(
  deps: WebhookDeps,
  workspaceId: number,
  provider: string,
  unsubscribes: readonly ProviderUnsubscribe[],
): Promise<number> {
  const hashEmail = requireService(deps.services, "hashEmail");
  const hashes = new Set<string>();
  for (const item of unsubscribes.slice(0, 100)) {
    const email = normalizeEmail(item.email);
    if (email) hashes.add(await hashEmail(email));
  }
  if (hashes.size === 0) return 0;
  const { db } = deps;
  const contacts = await db.db
    .selectFrom("contacts")
    .select(["id", "unsubscribed_at"])
    .where("workspace_id", "=", workspaceId)
    .where("email_hash", "in", [...hashes])
    .execute();
  const ids = contacts.filter((row) => row.unsubscribed_at === null).map((row) => row.id);
  if (ids.length === 0) return 0;
  const source = `provider:${provider}`;
  const now = Date.now();
  await db.atomic([
    db.db
      .updateTable("contacts")
      .set({
        unsubscribed_at: now,
        unsubscribe_source: source,
        unsubscribe_campaign_id: null,
        updated_at: now,
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "in", ids)
      .where("unsubscribed_at", "is", null),
    db.db
      .updateTable("list_members")
      .set({
        status: "unsubscribed",
        status_source: source,
        status_at: now,
        status_campaign_id: null,
      })
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "in", ids)
      .where("status", "=", "subscribed"),
  ]);
  if (deps.services.welcome) await stopWelcome(db, deps.services.welcome, workspaceId, ids);
  return ids.length;
}
