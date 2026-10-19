import { z } from "zod";
import { pageInputShape, pageOf, pageParams, toPage } from "../../pagination";
import { defineOperation } from "../operation";

export const AuditEntrySchema = z
  .object({
    id: z.number().int(),
    actorType: z.enum(["user", "api_key", "system"]),
    actorId: z.string().nullable(),
    surface: z.enum(["ui", "rest", "mcp", "system"]),
    apiKeyId: z.number().int().nullable(),
    action: z.string(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.number().int().meta({ description: "Unix milliseconds." }),
  })
  .meta({ id: "AuditEntry" });

function parseMetadata(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const auditList = defineOperation({
  id: "audit.list",
  summary: "List audit log entries",
  description: "Returns the workspace's audit log, newest first, with cursor pagination.",
  method: "get",
  path: "/audit-log",
  scope: "workspace:admin",
  risk: "read",
  mcp: {
    class: "never",
    reason: "The audit log is for the owner. API keys cannot hold the workspace:admin scope.",
  },
  input: z.object(pageInputShape),
  output: pageOf(AuditEntrySchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    // Newest first, so the next page has smaller ids. New rows appear only on page one.
    let query = db.db
      .selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId);
    if (afterId !== null) query = query.where("id", "<", afterId);
    const rows = await query.orderBy("id", "desc").limit(take).execute();
    return toPage(
      rows,
      input.limit,
      (row) => row.id,
      (row) => ({
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        surface: row.surface,
        apiKeyId: row.api_key_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: parseMetadata(row.metadata),
        createdAt: row.created_at,
      }),
    );
  },
});
