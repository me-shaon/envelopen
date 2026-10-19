import { z } from "zod";
import { pageInputShape, pageOf, pageParams, toPage } from "../../pagination";
import { defineOperation } from "../operation";

const SurfaceSchema = z.enum(["ui", "rest", "mcp", "system"]);

export const AuditEntrySchema = z
  .object({
    id: z.number().int(),
    actorType: z.enum(["user", "api_key", "system"]),
    actorId: z.string().nullable(),
    surface: SurfaceSchema,
    apiKeyId: z.number().int().nullable(),
    apiKeyName: z
      .string()
      .nullable()
      .meta({ description: "The name of the API key that acted, when it still exists." }),
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
  description:
    "Returns the workspace's audit log, newest first, with cursor pagination. Filter by " +
    "surface (`ui`, `rest`, `mcp`, or `system`) or by action (an operation id).",
  method: "get",
  path: "/audit-log",
  scope: "workspace:admin",
  risk: "read",
  mcp: {
    class: "never",
    reason: "The audit log is for the owner. API keys cannot hold the workspace:admin scope.",
  },
  input: z.object({
    surface: SurfaceSchema.optional(),
    action: z.string().trim().min(1).max(100).optional(),
    ...pageInputShape,
  }),
  output: pageOf(AuditEntrySchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    // Newest first, so the next page has smaller ids. New rows appear only on page one.
    let query = db.db
      .selectFrom("audit_log as a")
      .leftJoin("api_keys as k", (join) =>
        join.onRef("k.id", "=", "a.api_key_id").on("k.workspace_id", "=", principal.workspaceId),
      )
      .selectAll("a")
      .select("k.name as api_key_name")
      .where("a.workspace_id", "=", principal.workspaceId);
    if (input.surface !== undefined) query = query.where("a.surface", "=", input.surface);
    if (input.action !== undefined) query = query.where("a.action", "=", input.action);
    if (afterId !== null) query = query.where("a.id", "<", afterId);
    const rows = await query.orderBy("a.id", "desc").limit(take).execute();
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
        apiKeyName: row.api_key_name,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: parseMetadata(row.metadata),
        createdAt: row.created_at,
      }),
    );
  },
});

export const auditActions = defineOperation({
  id: "audit.actions",
  summary: "List the actions in the audit log",
  description: "Returns the distinct actions (operation ids) in the workspace's audit log.",
  method: "get",
  path: "/audit-log/actions",
  scope: "workspace:admin",
  risk: "read",
  mcp: {
    class: "never",
    reason: "The audit log is for the owner. API keys cannot hold the workspace:admin scope.",
  },
  input: z.object({}),
  output: z.object({ actions: z.array(z.string()) }).meta({ id: "AuditActions" }),
  async handler(_input, { principal, db }) {
    const rows = await db.db
      .selectFrom("audit_log")
      .select("action")
      .distinct()
      .where("workspace_id", "=", principal.workspaceId)
      .orderBy("action")
      .execute();
    return { actions: rows.map((row) => row.action) };
  },
});
