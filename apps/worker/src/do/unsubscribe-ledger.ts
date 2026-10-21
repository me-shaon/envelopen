import { DurableObject } from "cloudflare:workers";
import {
  type IntentInput,
  isIntentInput,
  type LedgerIntent,
  type LedgerStats,
  ledgerMeterName,
  MAX_INTENTS,
  type RecordResult,
} from "./unsubscribes";

// The UnsubscribeLedger (KTD1): unsubscribes that D1 rejected at its daily limit, in
// Durable Object SQLite storage, until the cron writes them to D1.
//
// - The public unsubscribe routes write an intent only after the token signature is
//   valid. An intent names the recipient of the token, and the workspace and contact
//   when D1 could still read them. The scope is one list or every list.
// - One intent per recipient and scope, and per known contact and scope. A repeated
//   request keeps the newest time.
// - At most MAX_INTENTS wait. Beyond it, `record` stores nothing, logs an alert, and
//   counts the overflow, so the route can tell the subscriber that the request failed.
// - The UsageMeter keeps a flag while intents wait (`unsubscribesPending`). The send
//   consumer reads it with the platform_limit flag, so the ledger costs no call while it
//   is empty. `record` sets the flag before it returns. `remove` clears it when the last
//   intent is gone. Each report carries a newer version, so an older one cannot undo it.
//
// One instance per deployment. The token holds no workspace id, and D1 cannot be read
// at the limit, so the route cannot find a workspace for a per-workspace instance.

export class UnsubscribeLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  workspace_id INTEGER,
  contact_id INTEGER,
  list_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (recipient_id, list_id)
)`);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS intents_contact_idx ON intents (workspace_id, contact_id)",
      );
    });
  }

  private count(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents").one().n;
  }

  /** The id of a stored intent with the same recipient or contact and scope. */
  private existing(intent: IntentInput): number | null {
    const listId = intent.listId ?? 0;
    const row = this.ctx.storage.sql
      .exec<{ id: number }>(
        `SELECT id FROM intents WHERE list_id = ? AND (recipient_id = ?
  OR (contact_id IS NOT NULL AND workspace_id = ? AND contact_id = ?)) LIMIT 1`,
        listId,
        intent.recipientId,
        intent.workspaceId ?? -1,
        intent.contactId ?? -1,
      )
      .toArray()[0];
    return row?.id ?? null;
  }

  /** Reports the flag to the UsageMeter with a version newer than every earlier one. */
  private async report(pending: boolean): Promise<void> {
    const last = (await this.ctx.storage.get<number>("version")) ?? 0;
    const version = Math.max(last + 1, Date.now());
    await this.ctx.storage.put("version", version);
    await this.env.USAGE_METER.getByName(ledgerMeterName(this.ctx.id.name)).setUnsubscribesPending(
      pending,
      version,
    );
  }

  /** Stores the intents of one request: all of them, or none when the ledger is full. */
  async record(intents: unknown[]): Promise<RecordResult> {
    const valid = intents.filter(isIntentInput);
    if (valid.length === 0) return { stored: true, added: 0 };
    const updates: [number, IntentInput][] = [];
    const inserts: IntentInput[] = [];
    for (const intent of valid) {
      const id = this.existing(intent);
      if (id === null) inserts.push(intent);
      else updates.push([id, intent]);
    }
    if (this.count() + inserts.length > MAX_INTENTS) {
      const overflow = ((await this.ctx.storage.get<number>("overflow")) ?? 0) + inserts.length;
      await this.ctx.storage.put("overflow", overflow);
      await this.ctx.storage.put("overflowAt", Date.now());
      console.error(
        `UnsubscribeLedger is full (${MAX_INTENTS} intents). ${overflow} unsubscribes were refused.`,
      );
      return { stored: false, reason: "full" };
    }
    this.ctx.storage.transactionSync(() => {
      for (const [id, intent] of updates) {
        this.ctx.storage.sql.exec(
          `UPDATE intents SET at = max(at, ?), workspace_id = coalesce(workspace_id, ?),
  contact_id = coalesce(contact_id, ?) WHERE id = ?`,
          intent.at,
          intent.workspaceId,
          intent.contactId,
          id,
        );
      }
      for (const intent of inserts) {
        this.ctx.storage.sql.exec(
          `INSERT INTO intents (campaign_id, recipient_id, workspace_id, contact_id, list_id, source, at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (recipient_id, list_id) DO UPDATE SET at = max(at, excluded.at)`,
          intent.campaignId,
          intent.recipientId,
          intent.workspaceId,
          intent.contactId,
          intent.listId ?? 0,
          intent.source,
          intent.at,
        );
      }
    });
    // The flag is set before the route answers, so no send starts after the success page
    // without a check of the ledger.
    await this.report(true);
    return { stored: true, added: inserts.length };
  }

  /** The waiting intents, oldest first. */
  async list(limit = MAX_INTENTS): Promise<LedgerIntent[]> {
    return this.ctx.storage.sql
      .exec<IntentRow>("SELECT * FROM intents ORDER BY at, id LIMIT ?", limit)
      .toArray()
      .map(toIntent);
  }

  /** The intents of one recipient, or of one known contact. */
  async find(ref: {
    recipientId: number;
    workspaceId?: number;
    contactId?: number;
  }): Promise<LedgerIntent[]> {
    return this.ctx.storage.sql
      .exec<IntentRow>(
        `SELECT * FROM intents WHERE recipient_id = ?
  OR (workspace_id = ? AND contact_id = ?) ORDER BY at, id`,
        ref.recipientId,
        ref.workspaceId ?? -1,
        ref.contactId ?? -1,
      )
      .toArray()
      .map(toIntent);
  }

  /**
   * Deletes intents that D1 has now, or that no longer apply. An intent whose time
   * changed after the caller read it stays, so a newer request is not lost. Clears the
   * UsageMeter flag when the ledger is empty. Returns the intents that still wait.
   */
  async remove(entries: { id: number; at: number }[]): Promise<number> {
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          "DELETE FROM intents WHERE id = ? AND at = ?",
          entry.id,
          entry.at,
        );
      }
    });
    const left = this.count();
    if (left === 0) await this.report(false);
    return left;
  }

  /** The waiting intents and the refused ones since the first overflow. */
  async stats(): Promise<LedgerStats> {
    return {
      waiting: this.count(),
      overflow: (await this.ctx.storage.get<number>("overflow")) ?? 0,
      overflowAt: (await this.ctx.storage.get<number>("overflowAt")) ?? null,
    };
  }
}

interface IntentRow extends Record<string, SqlStorageValue> {
  id: number;
  campaign_id: number;
  recipient_id: number;
  workspace_id: number | null;
  contact_id: number | null;
  list_id: number;
  source: string;
  at: number;
}

function toIntent(row: IntentRow): LedgerIntent {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    recipientId: row.recipient_id,
    workspaceId: row.workspace_id,
    contactId: row.contact_id,
    listId: row.list_id === 0 ? null : row.list_id,
    source: row.source === "preference_page" ? "preference_page" : "one_click",
    at: row.at,
  };
}
