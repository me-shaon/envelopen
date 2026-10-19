import type { DbConnection } from "@envelopen/db";
import { type OutgoingMessage, type SendBatchResult, sendBatch } from "@envelopen/providers";
import { OperationError } from "../errors";
import type { Services } from "../services";
import { adapterContext, adapterOf, type ConnectionRow, decryptCredentials, refsOf } from "./model";
import { sendingConnection } from "./policy-gate";

// Sends through the workspace's connection. Test sends and system email use it. The
// campaign engine (U9) uses the same adapter call with its own claim and results.

export interface SendDeps {
  db: DbConnection;
  services: Partial<Services>;
}

/** The workspace's active sending connection, or an error that says what to fix. */
export async function requireSendingConnection(
  db: DbConnection,
  workspaceId: number,
): Promise<ConnectionRow> {
  const row = await sendingConnection(db, workspaceId);
  if (!row) throw new OperationError("conflict", "Connect an email provider first.");
  if (row.status !== "active") {
    throw new OperationError(
      "conflict",
      row.status_detail ?? `${row.name} is not active. Check the connection.`,
    );
  }
  return row;
}

export async function sendThroughConnection(
  deps: SendDeps,
  row: ConnectionRow,
  messages: readonly OutgoingMessage[],
): Promise<SendBatchResult> {
  const adapter = adapterOf(row);
  return sendBatch(
    adapter,
    messages,
    await decryptCredentials(deps.services, row),
    adapterContext(deps.services, refsOf(row)),
  );
}

export interface SystemEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Defaults to `Envelopen <alerts@<the first verified sending domain>>`. */
  from?: string;
}

/**
 * Sends a system email, such as an owner alert, through the workspace's connection
 * (R63). There is no policy gate: a transactional-only connection can always send
 * system email, with or without the accepted warning (KTD14).
 */
export async function sendSystemEmail(deps: SendDeps, workspaceId: number, email: SystemEmail) {
  const row = await requireSendingConnection(deps.db, workspaceId);
  let from = email.from;
  if (!from) {
    const domain = await deps.db.db
      .selectFrom("sending_domains")
      .select("domain")
      .where("workspace_id", "=", workspaceId)
      .where("verified_at", "is not", null)
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!domain)
      throw new OperationError(
        "conflict",
        "Verify a sending domain before Envelopen can send alerts.",
      );
    from = `Envelopen <alerts@${domain.domain}>`;
  }
  const result = await sendThroughConnection(deps, row, [
    {
      recipientId: "system",
      kind: "system",
      from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      ...(email.text ? { text: email.text } : {}),
      headers: { "Auto-Submitted": "auto-generated" },
    },
  ]);
  return result.results[0];
}
