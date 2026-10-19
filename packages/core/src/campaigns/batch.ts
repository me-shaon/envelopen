import type { Database, DbConnection } from "@envelopen/db";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import type { ConnectionRow } from "../connections/model";
import { chunk } from "../contacts/writes";
import type { BatchPointer } from "../services";
import type { BatchRow, CampaignRow } from "./model";

// Database steps of the send consumer (KTD17, KTD18, KTD20). The consumer in
// apps/worker/src/queue/send-consumer.ts runs them in this order:
//
// 1. `loadBatchContext`: the batch, its campaign, and the connection. The consumer
//    drops the message, with no write, when the generation is stale, the batch is not
//    enqueued, or the campaign is not sending.
// 2. On a first claim, the send-time check (audience.ts), which builds the frozen set.
// 3. `claimBatch`: one compare-and-set write. It stores the frozen recipient set and,
//    for an idempotent provider, the idempotency key, so a retry rebuilds a
//    byte-identical payload with the same key (KTD18).
// 4. The provider call.
// 5. `resultQueries`: one atomic D1 batch with the recipient results, the batch
//    status, the tracked links, and the hourly and daily `sent` rollups. Every
//    statement is guarded by the batch's generation, so a stale writer changes nothing.

/** One recipient of a frozen batch, with every value that personalization reads. */
export interface FrozenRecipient {
  id: number;
  email: string;
  fields: Record<string, string | null>;
}

/**
 * The recipient set that the first claim stores (`campaign_batches.recipient_set`).
 * A retry of an idempotent provider sends exactly these recipients, with these values,
 * and makes no second send-time check.
 */
export interface FrozenSet {
  v: 1;
  /** The link origin at the first claim. */
  origin: string;
  recipients: FrozenRecipient[];
  /** Recipients that the send-time check skipped, with the reason. */
  skipped: { id: number; reason: string }[];
}

export function parseFrozenSet(text: string | null): FrozenSet | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as FrozenSet;
    return value?.v === 1 && Array.isArray(value.recipients) ? value : null;
  } catch {
    return null;
  }
}

export interface CampaignForBatch extends CampaignRow {
  ws_tracking_opens: number;
  ws_tracking_clicks: number;
}

export interface BatchContext {
  batch: BatchRow;
  campaign: CampaignForBatch;
  connection: ConnectionRow | null;
}

export async function loadBatchContext(
  db: DbConnection,
  pointer: BatchPointer,
): Promise<BatchContext | null> {
  const [batch, campaign] = await Promise.all([
    db.db
      .selectFrom("campaign_batches")
      .selectAll()
      .where("workspace_id", "=", pointer.workspaceId)
      .where("id", "=", pointer.batchId)
      .where("campaign_id", "=", pointer.campaignId)
      .executeTakeFirst(),
    db.db
      .selectFrom("campaigns")
      .innerJoin("workspaces as w", "w.id", "campaigns.workspace_id")
      .selectAll("campaigns")
      .select(["w.tracking_opens as ws_tracking_opens", "w.tracking_clicks as ws_tracking_clicks"])
      .where("campaigns.workspace_id", "=", pointer.workspaceId)
      .where("campaigns.id", "=", pointer.campaignId)
      .executeTakeFirst(),
  ]);
  if (!batch || !campaign) return null;
  const connection =
    campaign.connection_id === null
      ? null
      : ((await db.db
          .selectFrom("provider_connections")
          .selectAll()
          .where("workspace_id", "=", pointer.workspaceId)
          .where("id", "=", campaign.connection_id)
          .executeTakeFirst()) ?? null);
  return { batch, campaign, connection };
}

/** Values of the custom fields that the content uses, by contact id. */
export async function customFieldValues(
  db: DbConnection,
  workspaceId: number,
  contactIds: readonly number[],
  keys: readonly string[],
): Promise<Map<number, Record<string, string | null>>> {
  const values = new Map<number, Record<string, string | null>>();
  if (contactIds.length === 0 || keys.length === 0) return values;
  const rows = await db.db
    .selectFrom("contact_field_values as v")
    .innerJoin("contact_fields as f", (join) =>
      join.onRef("f.id", "=", "v.field_id").on("f.workspace_id", "=", workspaceId),
    )
    .select(["v.contact_id", "f.key", "v.value"])
    .where("v.workspace_id", "=", workspaceId)
    .where("v.contact_id", "in", [...contactIds])
    .where("f.key", "in", [...keys])
    .execute();
  for (const row of rows) {
    const record = values.get(row.contact_id) ?? {};
    record[row.key] = row.value;
    values.set(row.contact_id, record);
  }
  return values;
}

export interface Claim {
  frozen: FrozenSet;
  idempotencyKey: string | null;
  attempts: number;
}

/**
 * Claims an enqueued batch (KTD18): a compare-and-set on status `enqueued`, the
 * generation, and a sending campaign. The first claim stores the frozen set and the
 * key. A later claim (an idempotent retry) keeps the stored ones. Returns null when
 * another delivery of the message claimed the batch first.
 */
export async function claimBatch(
  db: DbConnection,
  pointer: BatchPointer,
  input: { frozen: FrozenSet | null; idempotencyKey: string | null; leaseUntil: number },
  now: number,
): Promise<Claim | null> {
  const { workspaceId, batchId, campaignId, generation } = pointer;
  const { rows } = await sql<{
    recipient_set: string | null;
    idempotency_key: string | null;
    attempts: number;
  }>`
UPDATE campaign_batches SET
  status = 'claimed',
  lease_until = ${input.leaseUntil},
  attempts = attempts + 1,
  first_claimed_at = COALESCE(first_claimed_at, ${now}),
  recipient_set = COALESCE(recipient_set, ${input.frozen ? JSON.stringify(input.frozen) : null}),
  idempotency_key = COALESCE(idempotency_key, ${input.idempotencyKey}),
  updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${batchId} AND campaign_id = ${campaignId}
  AND status = 'enqueued' AND generation = ${generation}
  AND EXISTS (SELECT 1 FROM campaigns c WHERE c.workspace_id = ${workspaceId} AND c.id = ${campaignId} AND c.status = 'sending')
RETURNING recipient_set, idempotency_key, attempts`.execute(db.db);
  const row = rows[0];
  if (!row) return null;
  const frozen = parseFrozenSet(row.recipient_set);
  if (!frozen) return null;
  return { frozen, idempotencyKey: row.idempotency_key, attempts: row.attempts };
}

type SqlValue = string | number | null;

function valuesClause(rows: ReadonlyArray<ReadonlyArray<SqlValue>>) {
  return sql.join(
    rows.map((row) => sql`(${sql.join(row)})`),
    sql`, `,
  );
}

/** The batch, at the generation of the claim, still belongs to this writer. */
function batchGuard(pointer: BatchPointer) {
  return sql`EXISTS (SELECT 1 FROM campaign_batches gb WHERE gb.workspace_id = ${pointer.workspaceId} AND gb.id = ${pointer.batchId} AND gb.generation = ${pointer.generation} AND gb.status IN ('claimed', 'uncertain'))`;
}

export interface BatchResults {
  sent: { id: number; providerMessageId: string | null }[];
  failed: { id: number; error: string }[];
  skipped: { id: number; reason: string }[];
  /**
   * - `done`: every recipient has a result.
   * - `pending`: a provider refusal left some unsent. The batch waits until `notBefore`.
   *   It forgets the frozen set and the key, unless `keepSet` is true.
   * - `claimed`: some results are unknown. The lease decides (sweep.ts).
   *
   * A `done` batch forgets the frozen set, because the set holds personal data (R21).
   */
  status: "done" | "pending" | "claimed";
  /**
   * With status `pending`: keep the frozen set and the key. The consumer sets it when
   * the claim reused a stored key, because an earlier attempt with that key can have
   * reached the provider. The next claim then sends the same payload with the same key,
   * and the provider drops the copies (KTD18). With a fresh key, every recipient that
   * the earlier attempt reached would get the email twice.
   */
  keepSet?: boolean;
  notBefore?: number | null;
  error?: string | null;
  /** Tracked links of the campaign, stored once (KTD26). */
  links?: readonly string[];
}

const HOUR_MS = 60 * 60 * 1000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The atomic group that records a batch's results. The last statement is the batch update. */
export function resultQueries(
  db: Kysely<Database>,
  pointer: BatchPointer,
  results: BatchResults,
  now: number,
): CompiledQuery[] {
  const { workspaceId, campaignId, batchId, generation } = pointer;
  const guard = batchGuard(pointer);
  const queries: CompiledQuery[] = [];

  for (const part of chunk(results.sent, 40)) {
    queries.push(
      sql`UPDATE campaign_recipients SET status = 'sent', provider_message_id = v.column2, sent_at = ${now}, error = NULL
FROM (VALUES ${valuesClause(part.map((row) => [row.id, row.providerMessageId]))}) AS v
WHERE campaign_recipients.workspace_id = ${workspaceId} AND campaign_recipients.id = v.column1
  AND campaign_recipients.batch_id = ${batchId} AND campaign_recipients.status = 'pending' AND ${guard}`.compile(
        db,
      ),
    );
  }
  for (const part of chunk(results.failed, 40)) {
    queries.push(
      sql`UPDATE campaign_recipients SET status = 'failed', error = v.column2
FROM (VALUES ${valuesClause(part.map((row) => [row.id, row.error.slice(0, 300)]))}) AS v
WHERE campaign_recipients.workspace_id = ${workspaceId} AND campaign_recipients.id = v.column1
  AND campaign_recipients.batch_id = ${batchId} AND campaign_recipients.status = 'pending' AND ${guard}`.compile(
        db,
      ),
    );
  }
  for (const part of chunk(results.skipped, 40)) {
    queries.push(
      sql`UPDATE campaign_recipients SET status = 'skipped', skip_reason = v.column2
FROM (VALUES ${valuesClause(part.map((row) => [row.id, row.reason]))}) AS v
WHERE campaign_recipients.workspace_id = ${workspaceId} AND campaign_recipients.id = v.column1
  AND campaign_recipients.batch_id = ${batchId} AND campaign_recipients.status = 'pending' AND ${guard}`.compile(
        db,
      ),
    );
  }
  const links = results.links ?? [];
  for (const part of chunk(
    links.map((url, idx) => [idx, url] as const),
    20,
  )) {
    queries.push(
      sql`INSERT INTO links (workspace_id, campaign_id, idx, url)
VALUES ${valuesClause(part.map(([idx, url]) => [workspaceId, campaignId, idx, url]))}
ON CONFLICT (campaign_id, idx) DO NOTHING`.compile(db),
    );
  }

  const sent = results.sent.length;
  if (sent > 0) {
    // The `sent` counters of the rollups that U11 reads (KTD32).
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const day = utcDay(now);
    queries.push(
      sql`INSERT INTO campaign_stats_hourly (workspace_id, campaign_id, hour, sent)
SELECT ${workspaceId}, ${campaignId}, ${hour}, ${sent} WHERE ${guard}
ON CONFLICT (campaign_id, hour) DO UPDATE SET sent = sent + excluded.sent`.compile(db),
      sql`INSERT INTO campaign_stats_daily (workspace_id, campaign_id, day, sent)
SELECT ${workspaceId}, ${campaignId}, ${day}, ${sent} WHERE ${guard}
ON CONFLICT (campaign_id, day) DO UPDATE SET sent = sent + excluded.sent`.compile(db),
      sql`INSERT INTO workspace_stats_daily (workspace_id, day, sent)
SELECT ${workspaceId}, ${day}, ${sent} WHERE ${guard}
ON CONFLICT (workspace_id, day) DO UPDATE SET sent = sent + excluded.sent`.compile(db),
    );
  }

  const retaining = results.status === "pending" && results.keepSet === true;
  const releasing = results.status === "pending" && !retaining;
  // A batch that keeps its set and key stays uncertain if an erase marked it so (erase.ts).
  const status =
    results.status === "claimed"
      ? sql`status`
      : retaining
        ? sql`CASE WHEN status = 'uncertain' THEN 'uncertain' ELSE 'pending' END`
        : results.status;
  queries.push(
    sql`UPDATE campaign_batches SET
  status = ${status},
  sent_count = sent_count + ${sent},
  failed_count = failed_count + ${results.failed.length},
  skipped_count = skipped_count + ${results.skipped.length},
  lease_until = ${results.status === "claimed" ? sql`lease_until` : null},
  not_before = ${results.status === "pending" ? (results.notBefore ?? null) : null},
  recipient_set = ${releasing || results.status === "done" ? null : sql`recipient_set`},
  idempotency_key = ${releasing ? null : sql`idempotency_key`},
  uncertain_at = ${results.status === "done" ? null : sql`uncertain_at`},
  last_error = ${results.error ?? null},
  updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${batchId} AND generation = ${generation}
  AND status IN ('claimed', 'uncertain')`.compile(db),
  );
  return queries;
}

/** Writes the results. Returns false when the batch moved on (a stale writer). */
export async function writeBatchResults(
  db: DbConnection,
  pointer: BatchPointer,
  results: BatchResults,
  now: number,
): Promise<boolean> {
  const out = await db.atomic(resultQueries(db.db, pointer, results, now));
  return (out.at(-1)?.meta.changes ?? 0) > 0;
}
