import { env } from "cloudflare:workers";
import { createDb, type DbConnection } from "@envelopen/db";
import { generateApiKey } from "../src/api-keys";
import type { ApiKeyScope } from "../src/scopes";

/** A connection that fails any tenant query without a workspace_id condition. */
export function testDb(): DbConnection {
  return createDb(env, { enforceWorkspaceScope: true });
}

export async function createWorkspace(conn: DbConnection, name = "Test"): Promise<number> {
  const row = await conn.db
    .insertInto("workspaces")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function createApiKey(
  conn: DbConnection,
  workspaceId: number,
  scopes: readonly string[] | ApiKeyScope[],
  extra: { expires_at?: number | null; revoked_at?: number | null } = {},
): Promise<{ key: string; id: number }> {
  const generated = await generateApiKey();
  const row = await conn.db
    .insertInto("api_keys")
    .values({
      workspace_id: workspaceId,
      name: "Test key",
      prefix: generated.prefix,
      key_hash: generated.keyHash,
      scopes: JSON.stringify(scopes),
      created_by_user_id: null,
      last_used_at: null,
      expires_at: extra.expires_at ?? null,
      revoked_at: extra.revoked_at ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { key: generated.key, id: row.id };
}

/** An app user, as first-run setup creates it. Returns the id. */
export async function createUser(conn: DbConnection, id = crypto.randomUUID()): Promise<string> {
  await conn.db
    .insertInto("users")
    .values({ id, email: `${id}@example.com`, name: null })
    .execute();
  return id;
}

/** A workspace with the user as its owner member. */
export async function createOwnedWorkspace(
  conn: DbConnection,
  userId: string,
  name = "Test",
): Promise<number> {
  const workspaceId = await createWorkspace(conn, name);
  await conn.db
    .insertInto("workspace_members")
    .values({ workspace_id: workspaceId, user_id: userId, role: "owner" })
    .execute();
  return workspaceId;
}
