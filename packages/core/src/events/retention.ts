import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";
import type { ProviderEventRef } from "./model";

// Cron jobs of the event pipeline (R51, KTD31, KTD32).
//
// - Retention: raw events (`email_events`) older than the workspace's retention period
//   are deleted. The rollups stay, so the dashboards keep their history. Applied
//   provider events go too, but never before 30 days, because the soft-bounce rule
//   counts them (R44).
// - Webhook nonces (Mailgun tokens) go when their timestamp window ends.
// - Rescue: a provider event that no flush applied (the hand-off to the EventBuffer
//   failed) goes to the buffer again after a few minutes.
//
// Both jobs read across workspaces on purpose (KTD4) and bound their work per run.
// A deleted row counts as a D1 row written, so the deletes stay small per run.

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The shortest retention a workspace can set, and the floor for provider events. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;
/** Rows that one retention run deletes from each table at most. */
export const RETENTION_BATCH = 2000;

/** How long the ids of committed EventBuffer flushes stay. A replay comes much sooner. */
export const FLUSH_ID_RETENTION_MS = 7 * DAY_MS;

/** Nonces that one run deletes, as a multiple of the limit of the other tables. */
export const NONCE_LIMIT_FACTOR = 5;

export interface RetentionResult {
  emailEvents: number;
  providerEvents: number;
  eventFlushes: number;
  webhookNonces: number;
}

export async function purgeExpiredEvents(
  db: DbConnection,
  now: number,
  limit = RETENTION_BATCH,
): Promise<RetentionResult> {
  const any = unscoped(db.db);
  // Each workspace reads only its own expired rows, through the (workspace_id,
  // occurred_at) indexes: CROSS JOIN keeps workspaces as the outer loop, and one upper
  // bound per workspace makes the index range end at the cutoff. A scan of occurred_at
  // alone read every row older than the floor each run, expired or not.
  const floor = now - MIN_RETENTION_DAYS * DAY_MS;
  const events = await sql`DELETE FROM email_events WHERE id IN (
  SELECT e.id FROM workspaces w CROSS JOIN email_events e
  WHERE e.workspace_id = w.id
    AND e.occurred_at < MIN(${floor}, ${now} - w.event_retention_days * ${DAY_MS})
  LIMIT ${limit})`.execute(any);
  const provider = await sql`DELETE FROM provider_events WHERE id IN (
  SELECT p.id FROM workspaces w CROSS JOIN provider_events p
  WHERE p.workspace_id = w.id AND p.processed_at IS NOT NULL
    AND p.occurred_at < MIN(${floor}, ${now} - MAX(w.event_retention_days, ${MIN_RETENTION_DAYS}) * ${DAY_MS})
  LIMIT ${limit})`.execute(any);
  const flushes = await sql`DELETE FROM event_flushes WHERE rowid IN (
  SELECT rowid FROM event_flushes WHERE created_at < ${now - FLUSH_ID_RETENTION_MS}
  LIMIT ${limit})`.execute(any);
  // After its window, the signature check rejects a token anyway (migration 0025). One
  // Mailgun event adds one nonce, so a large campaign adds many in an hour: this table
  // gets a larger limit.
  const nonces = await sql`DELETE FROM webhook_nonces WHERE rowid IN (
  SELECT rowid FROM webhook_nonces WHERE expires_at < ${now}
  LIMIT ${limit * NONCE_LIMIT_FACTOR})`.execute(any);
  return {
    emailEvents: Number(events.numAffectedRows ?? 0),
    providerEvents: Number(provider.numAffectedRows ?? 0),
    eventFlushes: Number(flushes.numAffectedRows ?? 0),
    webhookNonces: Number(nonces.numAffectedRows ?? 0),
  };
}

/** Provider events that waited longer than `olderThanMs` without a flush, by workspace. */
export async function unappliedProviderEvents(
  db: DbConnection,
  now: number,
  olderThanMs: number,
  limit = 200,
): Promise<Map<number, ProviderEventRef[]>> {
  const rows = await unscoped(db.db)
    .selectFrom("provider_events")
    .select(["id", "workspace_id", "type", "provider_message_id", "email_hash", "occurred_at"])
    .where("processed_at", "is", null)
    .where("received_at", "<", now - olderThanMs)
    .orderBy("received_at")
    .limit(limit)
    .execute();
  const byWorkspace = new Map<number, ProviderEventRef[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push({
      source: "provider",
      id: row.id,
      type: row.type,
      providerMessageId: row.provider_message_id,
      emailHash: row.email_hash,
      occurredAt: row.occurred_at,
    });
    byWorkspace.set(row.workspace_id, list);
  }
  return byWorkspace;
}
