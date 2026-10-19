import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../../errors";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "../../events/retention";
import { defineOperation } from "../operation";

export const WorkspaceSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    trackingOpens: z.boolean(),
    trackingClicks: z.boolean(),
    eventRetentionDays: z.number().int(),
    createdAt: z.number().int().meta({ description: "Unix milliseconds." }),
  })
  .meta({ id: "Workspace" });

export const workspacesGet = defineOperation({
  id: "workspaces.get",
  summary: "Get the current workspace",
  description: "Returns the workspace of the session or the API key.",
  method: "get",
  path: "/workspace",
  scope: "stats:read",
  risk: "read",
  mcp: {
    class: "later",
    reason:
      "U16 gives agents the workspace through get_workspace_context, which adds provider, domain, and usage status.",
  },
  input: z.object({}),
  output: WorkspaceSchema,
  async handler(_input, { principal, db }) {
    // `workspaces` is a global table, so the id filter is the scope here.
    const row = await db.db
      .selectFrom("workspaces")
      .select([
        "id",
        "name",
        "tracking_opens",
        "tracking_clicks",
        "event_retention_days",
        "created_at",
      ])
      .where("id", "=", principal.workspaceId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "The workspace does not exist.");
    return {
      id: row.id,
      name: row.name,
      trackingOpens: row.tracking_opens === 1,
      trackingClicks: row.tracking_clicks === 1,
      eventRetentionDays: row.event_retention_days,
      createdAt: row.created_at,
    };
  },
});

export const workspacesUpdateSettings = defineOperation({
  id: "workspaces.update_settings",
  summary: "Update the workspace settings",
  description:
    "Turns open and click tracking on or off for every campaign of the workspace (R45), " +
    "and sets how many days raw events are kept (R51). A campaign can turn tracking off " +
    "for itself, but not on when the workspace has it off. Rollups are kept for good.",
  method: "patch",
  path: "/workspace",
  scope: "workspace:admin",
  risk: "write",
  mcp: {
    class: "never",
    reason: "Workspace settings are for the owner. API keys cannot hold the workspace:admin scope.",
  },
  input: z.object({
    trackingOpens: z.boolean().optional(),
    trackingClicks: z.boolean().optional(),
    eventRetentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
  }),
  output: WorkspaceSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const set: { tracking_opens?: 0 | 1; tracking_clicks?: 0 | 1; event_retention_days?: number } =
      {};
    if (input.trackingOpens !== undefined) set.tracking_opens = input.trackingOpens ? 1 : 0;
    if (input.trackingClicks !== undefined) set.tracking_clicks = input.trackingClicks ? 1 : 0;
    if (input.eventRetentionDays !== undefined) set.event_retention_days = input.eventRetentionDays;
    if (Object.keys(set).length > 0) {
      await db.db
        .updateTable("workspaces")
        .set({ ...set, updated_at: now })
        .where("id", "=", principal.workspaceId)
        .where("archived_at", "is", null)
        .execute();
    }
    return workspacesGet.handler({}, ctx);
  },
  auditTarget: (input, output) => ({
    targetType: "workspace",
    targetId: output.id,
    metadata: { ...input },
  }),
});

// Workspace management (R5). Owner session only: workspace:admin, never through MCP.

const WORKSPACE_MCP = {
  class: "never",
  reason: "Workspace management is for the owner. API keys cannot hold the workspace:admin scope.",
} as const;

export const WorkspaceSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    archivedAt: z.number().int().nullable().meta({ description: "Unix milliseconds." }),
    createdAt: z.number().int().meta({ description: "Unix milliseconds." }),
  })
  .meta({ id: "WorkspaceSummary" });

const WorkspaceName = z.string().trim().min(1).max(100);

interface WorkspaceRow {
  id: number;
  name: string;
  archived_at: number | null;
  created_at: number;
}

function toSummary(row: WorkspaceRow) {
  return { id: row.id, name: row.name, archivedAt: row.archived_at, createdAt: row.created_at };
}

/** The workspace, when the principal's user is a member of it. Throws not_found otherwise. */
async function memberWorkspace(
  db: DbConnection,
  userId: string,
  workspaceId: number,
): Promise<WorkspaceRow> {
  const row = await db.db
    .selectFrom("workspaces")
    .innerJoin("workspace_members", "workspace_members.workspace_id", "workspaces.id")
    .select(["workspaces.id", "workspaces.name", "workspaces.archived_at", "workspaces.created_at"])
    .where("workspace_members.workspace_id", "=", workspaceId)
    .where("workspace_members.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The workspace does not exist.");
  return row;
}

export const workspacesList = defineOperation({
  id: "workspaces.list",
  summary: "List workspaces",
  description:
    "Returns every workspace of the signed-in owner, archived ones included, oldest first.",
  method: "get",
  path: "/workspaces",
  scope: "workspace:admin",
  risk: "read",
  mcp: WORKSPACE_MCP,
  input: z.object({}),
  output: z.object({ items: z.array(WorkspaceSummarySchema) }),
  async handler(_input, { principal, db }) {
    // The user's workspaces across the deployment, so deliberately unscoped (KTD4).
    const rows = await unscoped(db.db)
      .selectFrom("workspaces")
      .innerJoin("workspace_members", "workspace_members.workspace_id", "workspaces.id")
      .select([
        "workspaces.id",
        "workspaces.name",
        "workspaces.archived_at",
        "workspaces.created_at",
      ])
      .where("workspace_members.user_id", "=", principal.actorId)
      .orderBy("workspaces.id", "asc")
      .execute();
    return { items: rows.map(toSummary) };
  },
});

export const workspacesCreate = defineOperation({
  id: "workspaces.create",
  summary: "Create a workspace",
  description: "Creates a workspace with the signed-in owner as its only member.",
  method: "post",
  path: "/workspaces",
  scope: "workspace:admin",
  risk: "write",
  mcp: WORKSPACE_MCP,
  input: z.object({ name: WorkspaceName }),
  output: WorkspaceSummarySchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    // One batch: the workspace and the owner's membership commit together. The
    // membership takes the new workspace id from last_insert_rowid().
    const [created] = await db.atomic([
      db.db.insertInto("workspaces").values({ name: input.name, created_at: now, updated_at: now }),
      db.db.insertInto("workspace_members").values({
        workspace_id: sql<number>`last_insert_rowid()`,
        user_id: principal.actorId,
        role: "owner",
      }),
    ]);
    const id = created?.meta.last_row_id;
    if (typeof id !== "number") throw new Error("The workspace insert returned no id.");
    return { id, name: input.name, archivedAt: null, createdAt: now };
  },
  auditTarget: (_input, output) => ({ targetType: "workspace", targetId: output.id }),
});

export const workspacesRename = defineOperation({
  id: "workspaces.rename",
  summary: "Rename a workspace",
  method: "patch",
  path: "/workspaces/{id}",
  scope: "workspace:admin",
  risk: "write",
  mcp: WORKSPACE_MCP,
  input: z.object({ id: z.coerce.number().int().positive(), name: WorkspaceName }),
  output: WorkspaceSummarySchema,
  async handler(input, { principal, db, now }) {
    const row = await memberWorkspace(db, principal.actorId, input.id);
    await db.db
      .updateTable("workspaces")
      .set({ name: input.name, updated_at: now })
      .where("id", "=", row.id)
      .execute();
    return toSummary({ ...row, name: input.name });
  },
  auditTarget: (input, output) => ({
    targetType: "workspace",
    targetId: output.id,
    metadata: { name: input.name },
  }),
});

export const workspacesArchive = defineOperation({
  id: "workspaces.archive",
  summary: "Archive a workspace",
  description:
    "Archives a workspace. Its API keys stop working, and it leaves the workspace switcher. " +
    "The last active workspace cannot be archived.",
  method: "post",
  path: "/workspaces/{id}/archive",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: WORKSPACE_MCP,
  input: z.object({ id: z.coerce.number().int().positive() }),
  output: WorkspaceSummarySchema,
  async handler(input, { principal, db, now }) {
    const row = await memberWorkspace(db, principal.actorId, input.id);
    if (row.archived_at !== null) return toSummary(row);

    // Counts the user's active workspaces across the deployment (KTD4: deliberate).
    const active = await unscoped(db.db)
      .selectFrom("workspaces")
      .innerJoin("workspace_members", "workspace_members.workspace_id", "workspaces.id")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_members.user_id", "=", principal.actorId)
      .where("workspaces.archived_at", "is", null)
      .executeTakeFirstOrThrow();
    if (Number(active.count) <= 1) {
      throw new OperationError(
        "conflict",
        "This is your last active workspace. Create another workspace first.",
      );
    }

    await db.db
      .updateTable("workspaces")
      .set({ archived_at: now, updated_at: now })
      .where("id", "=", row.id)
      .where("archived_at", "is", null)
      .execute();
    return toSummary({ ...row, archived_at: now });
  },
  auditTarget: (_input, output) => ({ targetType: "workspace", targetId: output.id }),
});
