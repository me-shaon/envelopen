import type { DbConnection } from "@envelopen/db";
import { getAdapter } from "@envelopen/providers";
import { OperationError } from "../errors";
import { type ConnectionRow, selectedConnectionId } from "./model";

// The provider policy gate (R62, AE8, KTD14). The campaign engine (U9) calls
// `assertCampaignPolicy` in prepare, before it issues a confirm token. System email
// (owner alerts) skips the gate: a transactional-only connection can always send it.

export type CampaignPolicyCode = "no_connection" | "connection_error" | "policy_warning";

export type CampaignPolicy =
  | { allowed: true; connectionId: number; provider: string }
  | {
      allowed: false;
      code: CampaignPolicyCode;
      message: string;
      connectionId: number | null;
      /** For `policy_warning`: the text the owner must accept. */
      warning: string | null;
    };

/** The connection that sends the workspace's email, or null when none is selected. */
export async function sendingConnection(
  db: DbConnection,
  workspaceId: number,
): Promise<ConnectionRow | null> {
  const id = await selectedConnectionId(db, workspaceId);
  if (id === null) return null;
  const row = await db.db
    .selectFrom("provider_connections")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ?? null;
}

/** Whether campaigns can send through the workspace's connection now. */
export async function checkCampaignPolicy(
  db: DbConnection,
  workspaceId: number,
): Promise<CampaignPolicy> {
  const row = await sendingConnection(db, workspaceId);
  if (!row) {
    return {
      allowed: false,
      code: "no_connection",
      message: "Connect an email provider before you send a campaign.",
      connectionId: null,
      warning: null,
    };
  }
  if (row.status !== "active") {
    return {
      allowed: false,
      code: "connection_error",
      message: row.status_detail ?? `${row.name} is not active. Check the connection.`,
      connectionId: row.id,
      warning: null,
    };
  }
  if (row.policy === "transactional-only" && row.policy_warning_accepted_at === null) {
    const warning =
      getAdapter(row.provider)?.policyWarning ?? "This provider permits transactional email only.";
    return {
      allowed: false,
      code: "policy_warning",
      message: `${row.name} is a transactional-only provider. Accept its warning before you send a campaign through it.`,
      connectionId: row.id,
      warning,
    };
  }
  return { allowed: true, connectionId: row.id, provider: row.provider };
}

/** Throws a `conflict` with the gate result as details when campaigns cannot send. */
export async function assertCampaignPolicy(
  db: DbConnection,
  workspaceId: number,
): Promise<Extract<CampaignPolicy, { allowed: true }>> {
  const policy = await checkCampaignPolicy(db, workspaceId);
  if (!policy.allowed) throw new OperationError("conflict", policy.message, policy);
  return policy;
}
