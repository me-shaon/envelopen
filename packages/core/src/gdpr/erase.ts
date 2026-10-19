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
// - `audit_log` metadata about the contact, or with the address in it.
// - `idempotency_keys` with a stored response that holds the address.
// - `test_addresses` with the same address.
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
  const recipientIds = db.db
    .selectFrom("campaign_recipients")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", target.id);
  const messageIds = db.db
    .selectFrom("campaign_recipients")
    .select("provider_message_id")
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", target.id)
    .where("provider_message_id", "is not", null);

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
    // 1. Raw events. The recipient rows still carry the contact id here.
    db.db
      .deleteFrom("email_events")
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([eb("contact_id", "=", target.id), eb("recipient_id", "in", recipientIds)]),
      ),
    db.db
      .deleteFrom("provider_events")
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb("email_hash", "=", target.emailHash),
          eb("provider_message_id", "in", messageIds),
        ]),
      ),
    // 2. Recipient rows keep their status and times for the campaign counts.
    db.db
      .updateTable("campaign_recipients")
      .set({ contact_id: null, provider_message_id: null, error: null })
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", target.id),
    // 3. Audit metadata. The rows stay, so the log still shows that the actions happened.
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
    db.db
      .deleteFrom("test_addresses")
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", target.email),
    // 4. The contact. Foreign keys cascade to tags, memberships, fields, and consent.
    db.db
      .deleteFrom("contacts")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", target.id),
  ]);
  const changes = (index: number) => Number(results[index]?.meta.changes ?? 0);
  return {
    events: changes(1),
    providerEvents: changes(2),
    recipients: changes(3),
    auditEntries: changes(4),
  };
}
