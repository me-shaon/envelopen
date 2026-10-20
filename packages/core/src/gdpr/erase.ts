import type { DbConnection } from "@envelopen/db";
import { sql } from "kysely";

// Erase of one contact (R21). It removes the personal data and keeps two things:
// - The rollups. They hold counts per campaign and day, and no person.
// - The suppression, keyed on the HMAC of the address (suppression/hash.ts). A later
//   import or upsert of the same address then stays suppressed.
//
// Personal data lives in these places, and the erase covers each one:
// - `contacts`, with its tags, list memberships, field values, and consent events
//   (foreign keys cascade).
// - Raw events: `email_events` of the contact, and `provider_events` with the address
//   hash or one of the contact's provider message ids.
// - `campaign_recipients`: the rows stay for the batch bookkeeping, but lose the
//   contact link, the provider message id, and the provider error text.
// - `campaign_batches.recipient_set` of an open batch (batch.ts). A done or skipped
//   batch has no set. The erase removes the contact's entry from the set, and records
//   the recipient as skipped, so the batch never sends to the address.
// - `audit_log` metadata about the contact, or with the address in it.
// - `idempotency_keys` with a stored response that holds the address.
// - `test_addresses` with the same address.
// - `consent_tombstones` with the address hash. The suppression is enough.
//
// Files in R2 (import uploads, error files, and contact exports) can hold the address
// too. They expire after FILE_TTL_MS, and cleanup deletes them.

export interface EraseTarget {
  id: number;
  /** The normalized address. */
  email: string;
  /** The keyed hash of the normalized address. */
  emailHash: string;
}

export interface EraseResult {
  events: number;
  providerEvents: number;
  recipients: number;
  auditEntries: number;
}

const ERASED_IN_RETRY =
  "A contact in this batch was erased while the batch waited for a retry with its stored key. Retry or skip the batch.";

/** A LIKE pattern that matches the text anywhere, with the wildcards in it escaped. */
export function containsPattern(text: string): string {
  return `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/**
 * Erases one contact in one atomic batch. The suppression insert comes first, so the
 * address can never be added back between two statements.
 */
export async function eraseContact(
  db: DbConnection,
  workspaceId: number,
  target: EraseTarget,
  options: { now: number; source: string },
): Promise<EraseResult> {
  const pattern = containsPattern(target.email);
  const messageIds = db.db
    .selectFrom("campaign_recipients")
    .select("provider_message_id")
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", target.id)
    .where("provider_message_id", "is not", null);

  // An open batch that will send its stored set again with its stored key.
  const retrying = sql`(idempotency_key IS NOT NULL AND status IN ('pending', 'enqueued', 'claimed'))`;
  const results = await db.atomic([
    db.db
      .insertInto("suppressions")
      .values({
        workspace_id: workspaceId,
        email_hash: target.emailHash,
        reason: "erased",
        source: options.source,
        campaign_id: null,
        created_at: options.now,
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "email_hash"]).doNothing()),
    // 1. Raw events. An event stores the contact id of its recipient, and a recipient's
    // contact id only changes to NULL, so this also covers the events of every recipient
    // of the contact (migration 0014). INDEXED BY: SQLite otherwise reads the workspace's
    // events through the index that starts with workspace_id.
    sql`DELETE FROM email_events INDEXED BY email_events_contact_idx
WHERE contact_id = ${target.id} AND workspace_id = ${workspaceId}`.compile(db.db),
    db.db
      .deleteFrom("provider_events")
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb("email_hash", "=", target.emailHash),
          eb("provider_message_id", "in", messageIds),
        ]),
      ),
    // 2. Frozen sets of open batches. The recipient rows still carry the contact id here.
    // A set with a stored key belongs to an idempotent retry: an earlier attempt can have
    // reached the provider. A changed payload cannot reuse that key, and a new key can
    // send the others a second copy. So the batch becomes uncertain, and the owner decides.
    sql`UPDATE campaign_batches SET
  status = CASE WHEN ${retrying} THEN 'uncertain' ELSE status END,
  uncertain_at = CASE WHEN ${retrying} THEN ${options.now} ELSE uncertain_at END,
  lease_until = CASE WHEN ${retrying} THEN NULL ELSE lease_until END,
  last_error = CASE WHEN ${retrying} THEN ${ERASED_IN_RETRY} ELSE last_error END,
  recipient_set = json_set(
    json_insert(recipient_set, '$.skipped[#]', json_object('id', r.rid, 'reason', 'deleted')),
    '$.recipients',
    (SELECT json_group_array(json(e.value)) FROM json_each(campaign_batches.recipient_set, '$.recipients') e
      WHERE json_extract(e.value, '$.id') IS NOT r.rid)
  ),
  updated_at = ${options.now}
FROM (SELECT id AS rid, batch_id FROM campaign_recipients
  WHERE workspace_id = ${workspaceId} AND contact_id = ${target.id} AND batch_id IS NOT NULL) AS r
WHERE campaign_batches.workspace_id = ${workspaceId} AND campaign_batches.id = r.batch_id
  AND campaign_batches.recipient_set IS NOT NULL
  AND EXISTS (SELECT 1 FROM json_each(campaign_batches.recipient_set, '$.recipients') e
    WHERE json_extract(e.value, '$.id') = r.rid)`.compile(db.db),
    // 3. Recipient rows keep their status and times for the campaign counts.
    db.db
      .updateTable("campaign_recipients")
      .set({ contact_id: null, provider_message_id: null, error: null })
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", target.id),
    // 4. Audit metadata. The rows stay, so the log still shows that the actions happened.
    db.db
      .updateTable("audit_log")
      .set({ metadata: null })
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb.and([eb("target_type", "=", "contact"), eb("target_id", "=", String(target.id))]),
          sql<boolean>`metadata LIKE ${pattern} ESCAPE '\\'`,
        ]),
      ),
    db.db
      .deleteFrom("idempotency_keys")
      .where("workspace_id", "=", workspaceId)
      .where(sql<boolean>`response_body LIKE ${pattern} ESCAPE '\\'`),
    // The suppression above blocks every send, so the consent tombstone (a second
    // hash of the address) is not needed and goes.
    db.db
      .deleteFrom("consent_tombstones")
      .where("workspace_id", "=", workspaceId)
      .where("email_hash", "=", target.emailHash),
    db.db
      .deleteFrom("test_addresses")
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", target.email),
    // 5. The contact. Foreign keys cascade to tags, memberships, fields, and consent.
    db.db
      .deleteFrom("contacts")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", target.id),
  ]);
  const changes = (index: number) => Number(results[index]?.meta.changes ?? 0);
  return {
    events: changes(1),
    providerEvents: changes(2),
    recipients: changes(4),
    auditEntries: changes(5),
  };
}
