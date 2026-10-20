import { env } from "cloudflare:workers";
import {
  auditList,
  createRegistry,
  defineOperation,
  generateApiKey,
  OperationError,
  pageInputShape,
  pageOf,
  pageParams,
  sessionPrincipal,
  toPage,
  workspacesGet,
} from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionResolver } from "../src/api/auth";
import { type ApiRouterOptions, createApiRouter } from "../src/api/router";

export const ORIGIN = "https://envelopen.test";

export function testDb(): DbConnection {
  return createDb(env, { enforceWorkspaceScope: true });
}

// Test-only operations. Later units add the real domain operations.
const ListSchema = z.object({ id: z.number(), name: z.string() });

export const createList = defineOperation({
  id: "test_lists.create",
  summary: "Create a list (test only)",
  method: "post",
  path: "/test/lists",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "never", reason: "Test operation." },
  input: z.object({ name: z.string().min(1) }),
  output: ListSchema,
  successStatus: 201,
  async handler(input, { principal, db }) {
    return db.db
      .insertInto("lists")
      .values({ workspace_id: principal.workspaceId, name: input.name })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
  },
  auditTarget: (_input, output) => ({ targetType: "list", targetId: output.id }),
});

export const getList = defineOperation({
  id: "test_lists.get",
  summary: "Get a list (test only)",
  method: "get",
  path: "/test/lists/{id}",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "never", reason: "Test operation." },
  input: z.object({ id: z.coerce.number().int() }),
  output: ListSchema,
  async handler(input, { principal, db }) {
    const row = await db.db
      .selectFrom("lists")
      .select(["id", "name"])
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "No such list.");
    return row;
  },
});

export const renameList = defineOperation({
  id: "test_lists.rename",
  summary: "Rename a list (test only)",
  method: "post",
  path: "/test/lists/{id}/rename",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "never", reason: "Test operation." },
  input: z.object({ id: z.coerce.number().int(), name: z.string().min(1) }),
  output: ListSchema,
  async handler(input, { principal, db }) {
    const row = await db.db
      .updateTable("lists")
      .set({ name: input.name })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "No such list.");
    return row;
  },
  auditTarget: (_input, output) => ({ targetType: "list", targetId: output.id }),
});

export const listContacts = defineOperation({
  id: "test_contacts.list",
  summary: "List contacts (test only)",
  method: "get",
  path: "/test/contacts",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "never", reason: "Test operation." },
  input: z.object(pageInputShape),
  output: pageOf(z.object({ id: z.number(), email: z.string() })),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("contacts")
      .select(["id", "email"])
      .where("workspace_id", "=", principal.workspaceId);
    if (afterId !== null) query = query.where("id", ">", afterId);
    const rows = await query.orderBy("id", "asc").limit(take).execute();
    return toPage(
      rows,
      input.limit,
      (row) => row.id,
      (row) => row,
    );
  },
});

export const testRegistry = createRegistry([
  workspacesGet,
  auditList,
  createList,
  getList,
  renameList,
  listContacts,
]);

/** Test sessions: the cookie `test_session=<userId>:<workspaceId>`. U4 brings real sessions. */
export const cookieSessionResolver: SessionResolver = async (c) => {
  const match = /(?:^|;\s*)test_session=([^:;]+):(\d+)/.exec(c.req.header("cookie") ?? "");
  if (!match) return null;
  return sessionPrincipal({ userId: match[1] as string, workspaceId: Number(match[2]) });
};

export function createTestApp(options: ApiRouterOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    "/api",
    createApiRouter({
      registry: testRegistry,
      resolveSession: cookieSessionResolver,
      createDb: (bindings) => createDb(bindings, { enforceWorkspaceScope: true }),
      ...options,
    }),
  );
  return {
    request: (path: string, init: RequestInit = {}) =>
      app.request(`${ORIGIN}/api${path}`, init, env),
  };
}

export async function createWorkspace(name = "Test"): Promise<number> {
  const row = await testDb()
    .db.insertInto("workspaces")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function createApiKey(
  workspaceId: number,
  scopes: string[],
): Promise<{ key: string; id: number }> {
  const generated = await generateApiKey();
  const row = await testDb()
    .db.insertInto("api_keys")
    .values({
      workspace_id: workspaceId,
      name: "Test key",
      prefix: generated.prefix,
      key_hash: generated.keyHash,
      scopes: JSON.stringify(scopes),
      created_by_user_id: null,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { key: generated.key, id: row.id };
}

export function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

export async function countRows(
  table: "lists" | "audit_log" | "idempotency_keys",
  workspaceId: number,
): Promise<number> {
  const rows = await testDb()
    .db.selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return Number(rows.count);
}
