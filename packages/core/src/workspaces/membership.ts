import { type DbConnection, unscoped } from "@envelopen/db";
import { OperationError } from "../errors";
import { type Principal, sessionPrincipal } from "../principal";

/**
 * The request header that picks the workspace of a session request. Without it, the
 * session uses the user's oldest active workspace. API keys ignore it: a key belongs
 * to one workspace.
 */
export const WORKSPACE_HEADER = "X-Envelopen-Workspace";

/**
 * Resolves the session principal of a signed-in user (KTD10). The user must be a
 * member of the workspace, and the workspace must be active. In v1 the only role is
 * `owner`, and the owner has every scope.
 *
 * @param requested The raw header value, or undefined for the default workspace.
 * @param signedInAt When the session's sign-in completed (Unix milliseconds).
 */
export async function resolveSessionPrincipal(
  conn: DbConnection,
  userId: string,
  requested: string | undefined,
  signedInAt: number | null = null,
): Promise<Principal> {
  let workspaceId: number | undefined;
  if (requested !== undefined) {
    if (!/^\d{1,15}$/.test(requested.trim())) {
      throw new OperationError("invalid_input", `${WORKSPACE_HEADER} must be a workspace id.`);
    }
    workspaceId = Number(requested.trim());
  }

  // Without a workspace id this lists the user's workspaces, so it is deliberately
  // unscoped (KTD4). With an id, the id is the scope.
  let query = unscoped(conn.db)
    .selectFrom("workspace_members")
    .innerJoin("workspaces", "workspaces.id", "workspace_members.workspace_id")
    .select(["workspace_members.workspace_id", "workspace_members.role"])
    .where("workspace_members.user_id", "=", userId)
    .where("workspaces.archived_at", "is", null);
  if (workspaceId !== undefined) {
    query = query.where("workspace_members.workspace_id", "=", workspaceId);
  }
  const membership = await query
    .orderBy("workspace_members.workspace_id", "asc")
    .limit(1)
    .executeTakeFirst();

  if (!membership) {
    throw workspaceId === undefined
      ? new OperationError("forbidden", "You have no active workspace.")
      : new OperationError("not_found", "The workspace does not exist or is archived.");
  }
  if (membership.role !== "owner") {
    // v1.x adds roles with their own scopes. Until then, only the owner signs in.
    throw new OperationError("forbidden", "Your role has no access in this version.");
  }
  return sessionPrincipal({ workspaceId: membership.workspace_id, userId, signedInAt });
}
