import { z } from "zod";
import { OperationError } from "../../errors";
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
