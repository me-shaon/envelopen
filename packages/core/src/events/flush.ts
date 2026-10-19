import type { DbConnection, EmailEventType } from "@envelopen/db";
import { type CompiledQuery, sql } from "kysely";
import { aggregateRollups, type RollupEvent, rollupQueries } from "../stats/rollups";
import {
  type BufferedEvent,
  type ProviderEventRef,
  SOFT_BOUNCE_LIMIT,
  SOFT_BOUNCE_WINDOW_MS,
  type TrackingEvent,
} from "./model";

// The EventBuffer flush (KTD31, KTD32): one group of buffered events of one workspace
// into D1. The flush:
//
// 1. Reads, in at most three queries: which provider events are still unapplied, the
//    campaign recipients of the provider events (by provider message id), and the first
//    human open and click of the tracked recipients.
// 2. Writes one atomic batch: the raw events, the first open and click of each
//    recipient, the hourly and daily rollups, the human clicks of each link (for the
//    click map, U11), `processed_at` of the provider events, and the soft-bounce rule.
//    The batch has at most 10 statements, whatever the number of events, because the
//    rows travel as one JSON parameter each (`json_each`).
//
// Hard bounces and complaints are suppressed earlier, when the webhook stores them
// (connections/webhooks.ts). The soft-bounce rule runs here: the third soft bounce of
// an address within 30 days suppresses it (R44). It counts `provider_events`, which
// holds every verified bounce once, with its time.
//
// A provider event that matches no campaign recipient (a test send or a system email)
// is marked as applied and adds no raw event or rollup.

export interface FlushResult {
  events: number;
  /** Raw events written to `email_events`. */
  stored: number;
  /** D1 statements that the flush ran, reads included. */
  statements: number;
}

interface EventRow {
  c: number;
  r: number;
  ct: number | null;
  ty: EmailEventType;
  l: number | null;
  pm: string | null;
  m: 0 | 1;
  b: 0 | 1;
  d: string | null;
  t: number;
}

const PROVIDER_TYPES: Record<ProviderEventRef["type"], EmailEventType> = {
  delivered: "delivered",
  bounce_hard: "bounce_hard",
  bounce_soft: "bounce_soft",
  complaint: "complaint",
  failed: "failed",
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

export async function flushEvents(
  db: DbConnection,
  workspaceId: number,
  events: readonly BufferedEvent[],
  now: number,
): Promise<FlushResult> {
  let statements = 0;
  const tracking = events.filter((event): event is TrackingEvent => event.source === "tracking");
  const provider = events.filter((event): event is ProviderEventRef => event.source === "provider");

  // 1. Reads.
  let pending = new Set<number>();
  const byMessage = new Map<
    string,
    { id: number; campaign_id: number; contact_id: number | null }
  >();
  if (provider.length > 0) {
    statements++;
    const open = await sql<{ id: number }>`SELECT id FROM provider_events
WHERE workspace_id = ${workspaceId} AND processed_at IS NULL
  AND id IN (SELECT value FROM json_each(${json(provider.map((event) => event.id))}))`.execute(
      db.db,
    );
    pending = new Set(open.rows.map((row) => row.id));
    const messageIds = [
      ...new Set(
        provider
          .filter((event) => pending.has(event.id) && event.providerMessageId)
          .map((event) => event.providerMessageId as string),
      ),
    ];
    if (messageIds.length > 0) {
      statements++;
      const recipients = await sql<{
        id: number;
        campaign_id: number;
        contact_id: number | null;
        provider_message_id: string;
      }>`SELECT id, campaign_id, contact_id, provider_message_id FROM campaign_recipients
WHERE workspace_id = ${workspaceId}
  AND provider_message_id IN (SELECT value FROM json_each(${json(messageIds)}))`.execute(db.db);
      for (const row of recipients.rows) byMessage.set(row.provider_message_id, row);
    }
  }
  const firsts = new Map<number, { opened: number | null; clicked: number | null }>();
  const tracked = [...new Set(tracking.map((event) => event.recipientId))];
  if (tracked.length > 0) {
    statements++;
    const rows = await sql<{
      id: number;
      opened_at: number | null;
      clicked_at: number | null;
    }>`SELECT id, opened_at, clicked_at FROM campaign_recipients
WHERE workspace_id = ${workspaceId} AND id IN (SELECT value FROM json_each(${json(tracked)}))`.execute(
      db.db,
    );
    for (const row of rows.rows) {
      firsts.set(row.id, { opened: row.opened_at, clicked: row.clicked_at });
    }
  }

  // 2. Rows, in time order, so the first human open or click is the earliest one.
  const rows: EventRow[] = [];
  const rollup: RollupEvent[] = [];
  const firstOpens = new Map<number, number>();
  const firstClicks = new Map<number, number>();
  const linkClicks = new Map<number, number>();
  const ordered = [...tracking].sort((a, b) => a.occurredAt - b.occurredAt);
  for (const event of ordered) {
    const first = firsts.get(event.recipientId);
    // The recipient is gone (its campaign was deleted) or belongs to another workspace.
    if (!first) continue;
    let unique = false;
    if (event.type === "open" && !event.machine && first.opened === null) {
      unique = !firstOpens.has(event.recipientId);
      if (unique) firstOpens.set(event.recipientId, event.occurredAt);
    }
    if (event.type === "click" && !event.bot && first.clicked === null) {
      unique = !firstClicks.has(event.recipientId);
      if (unique) firstClicks.set(event.recipientId, event.occurredAt);
    }
    if (event.type === "click" && !event.bot && event.linkId !== null) {
      linkClicks.set(event.linkId, (linkClicks.get(event.linkId) ?? 0) + 1);
    }
    rows.push({
      c: event.campaignId,
      r: event.recipientId,
      ct: event.contactId,
      ty: event.type,
      l: event.linkId,
      pm: null,
      m: event.machine ? 1 : 0,
      b: event.bot ? 1 : 0,
      d: event.reason ? json({ reason: event.reason }) : null,
      t: event.occurredAt,
    });
    rollup.push({
      campaignId: event.campaignId,
      type: event.type,
      machine: event.machine,
      bot: event.bot,
      unique,
      occurredAt: event.occurredAt,
    });
  }
  const applied: number[] = [];
  const softBounces = new Map<string, number>();
  for (const event of provider) {
    if (!pending.has(event.id)) continue;
    applied.push(event.id);
    if (event.type === "bounce_soft" && event.emailHash) {
      softBounces.set(
        event.emailHash,
        Math.max(softBounces.get(event.emailHash) ?? 0, event.occurredAt),
      );
    }
    const recipient = event.providerMessageId ? byMessage.get(event.providerMessageId) : undefined;
    if (!recipient) continue;
    const type = PROVIDER_TYPES[event.type];
    rows.push({
      c: recipient.campaign_id,
      r: recipient.id,
      ct: recipient.contact_id,
      ty: type,
      l: null,
      pm: event.providerMessageId,
      m: 0,
      b: 0,
      d: null,
      t: event.occurredAt,
    });
    rollup.push({
      campaignId: recipient.campaign_id,
      type,
      machine: false,
      bot: false,
      unique: false,
      occurredAt: event.occurredAt,
    });
  }

  // 3. One atomic batch.
  const writes: CompiledQuery[] = [];
  if (rows.length > 0) {
    writes.push(
      sql`INSERT INTO email_events (workspace_id, campaign_id, recipient_id, contact_id, type, link_id, provider_message_id, is_machine, is_bot, data, occurred_at)
SELECT ${workspaceId}, json_extract(value, '$.c'), json_extract(value, '$.r'), json_extract(value, '$.ct'),
  json_extract(value, '$.ty'), json_extract(value, '$.l'), json_extract(value, '$.pm'),
  json_extract(value, '$.m'), json_extract(value, '$.b'), json_extract(value, '$.d'), json_extract(value, '$.t')
FROM json_each(${json(rows)})`.compile(db.db),
    );
  }
  for (const [column, firstOf] of [
    ["opened_at", firstOpens],
    ["clicked_at", firstClicks],
  ] as const) {
    if (firstOf.size === 0) continue;
    writes.push(
      sql`UPDATE campaign_recipients SET ${sql.ref(column)} = j.t
FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS t FROM json_each(${json([...firstOf])})) AS j
WHERE campaign_recipients.workspace_id = ${workspaceId} AND campaign_recipients.id = j.id
  AND campaign_recipients.${sql.ref(column)} IS NULL`.compile(db.db),
    );
  }
  writes.push(...rollupQueries(db.db, workspaceId, aggregateRollups(rollup)));
  if (linkClicks.size > 0) {
    writes.push(
      sql`UPDATE links SET clicks = clicks + j.n
FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS n FROM json_each(${json([...linkClicks])})) AS j
WHERE links.workspace_id = ${workspaceId} AND links.id = j.id`.compile(db.db),
    );
  }
  if (applied.length > 0) {
    writes.push(
      sql`UPDATE provider_events SET processed_at = ${now}
WHERE workspace_id = ${workspaceId} AND processed_at IS NULL
  AND id IN (SELECT value FROM json_each(${json(applied)}))`.compile(db.db),
    );
  }
  if (softBounces.size > 0) {
    // For each address, count the soft bounces in the 30 days up to its newest one.
    writes.push(
      sql`INSERT INTO suppressions (workspace_id, email_hash, reason, source, campaign_id)
SELECT ${workspaceId}, j.h, 'soft_bounce_limit', 'soft_bounces', NULL
FROM (SELECT json_extract(value, '$[0]') AS h, json_extract(value, '$[1]') AS t FROM json_each(${json([...softBounces])})) AS j
WHERE (
  SELECT COUNT(*) FROM provider_events p
  WHERE p.workspace_id = ${workspaceId} AND p.type = 'bounce_soft' AND p.email_hash = j.h
    AND p.occurred_at > j.t - ${SOFT_BOUNCE_WINDOW_MS} AND p.occurred_at <= j.t
) >= ${SOFT_BOUNCE_LIMIT}
ON CONFLICT (workspace_id, email_hash) DO NOTHING`.compile(db.db),
    );
  }
  if (writes.length > 0) {
    statements += writes.length;
    await db.atomic(writes);
  }
  return { events: events.length, stored: rows.length, statements };
}
