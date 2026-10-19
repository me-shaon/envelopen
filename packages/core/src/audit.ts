import type { Database } from "@envelopen/db";
import type { Kysely } from "kysely";
import type { Principal } from "./principal";

/** What an audited action changed. */
export interface AuditTarget {
  targetType?: string;
  targetId?: string | number;
  /** Extra facts about the action. Never put secrets or contact content here. */
  metadata?: Record<string, unknown>;
}

export interface AuditEntry extends AuditTarget {
  /** The operation id, for example `contacts.upsert`. */
  action: string;
  ip?: string | null;
}

/**
 * Builds the audit log insert for an action by a principal (R8). Return it to
 * `atomic()` to commit it with the write, or execute it on its own.
 */
export function auditInsert(db: Kysely<Database>, principal: Principal, entry: AuditEntry) {
  return db.insertInto("audit_log").values({
    workspace_id: principal.workspaceId,
    actor_type: principal.actorType,
    actor_id: principal.actorId,
    surface: principal.surface,
    api_key_id: principal.apiKeyId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId === undefined ? null : String(entry.targetId),
    metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    ip: entry.ip ?? null,
  });
}

export async function writeAudit(
  db: Kysely<Database>,
  principal: Principal,
  entry: AuditEntry,
): Promise<void> {
  await auditInsert(db, principal, entry).execute();
}
