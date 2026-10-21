import type { DbConnection } from "@envelopen/db";
import {
  getAdapter,
  isSnsUrl,
  type NormalizedEvent,
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

export interface WebhookOutcome {
  /** HTTP status for the provider: 200 stops its retries, 401 and 404 mean "not for us". */
  status: 200 | 401 | 404;
  received: number;
  stored: number;
  confirmedSubscription: boolean;
  /** The rows that this request added, for the event pipeline. Replays add none. */
  events: ProviderEventRef[];
}

export interface WebhookDeps {
  db: DbConnection;
  services: Partial<Services>;
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
  return {
    status: 200,
    received: parsed.events.length,
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
