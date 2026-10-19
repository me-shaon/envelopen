import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspace, testDb } from "../test/fixtures";
import { OperationError } from "./errors";
import { runOperation } from "./executor";
import { apiKeyPrincipal, sessionPrincipal } from "./principal";
import { defineOperation } from "./registry";

const createTag = defineOperation({
  id: "test_tags.create",
  summary: "Create a tag (test only)",
  method: "post",
  path: "/test/tags",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Test operation." },
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.number(), name: z.string() }),
  async handler(input, { principal, db }) {
    const row = await db.db
      .insertInto("tags")
      .values({ workspace_id: principal.workspaceId, name: input.name })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    return { ...row, secret: "not in the output schema" };
  },
  auditTarget: (_input, output) => ({ targetType: "tag", targetId: output.id }),
});

const listOnlyLater = defineOperation({
  ...createTag,
  id: "test_tags.create_later",
  mcp: { class: "later", reason: "Test operation." },
});

async function countTags(workspaceId: number): Promise<number> {
  const rows = await testDb()
    .db.selectFrom("tags")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .execute();
  return rows.length;
}

describe("runOperation", () => {
  it("rejects a principal without the scope before the handler runs", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const principal = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read"],
      surface: "rest",
    });

    const error = await runOperation(principal, createTag, { name: "vip" }, { db: conn }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe("forbidden");
    expect(await countTags(workspaceId)).toBe(0);

    const audit = await conn.db
      .selectFrom("audit_log")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(audit).toEqual([]);
  });

  it("writes an audit row with the actor, surface, key id, and target", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const principal = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 42,
      scopes: ["lists:write"],
      surface: "rest",
    });

    const output = await runOperation(
      principal,
      createTag,
      { name: "vip" },
      { db: conn, ip: "203.0.113.9" },
    );
    expect(output).toEqual({ id: expect.any(Number), name: "vip" });

    const audit = await conn.db
      .selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_type: "api_key",
      actor_id: "42",
      surface: "rest",
      api_key_id: 42,
      action: "test_tags.create",
      target_type: "tag",
      target_id: String(output.id),
      ip: "203.0.113.9",
    });
  });

  it("gives the owner session every scope", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const principal = sessionPrincipal({ workspaceId, userId: "user-1" });
    await runOperation(principal, createTag, { name: "owner" }, { db: conn });

    const audit = await conn.db
      .selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_type: "user", actor_id: "user-1", surface: "ui" });
    expect(audit.api_key_id).toBeNull();
  });

  it("rejects invalid input with invalid_input and writes nothing", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const principal = sessionPrincipal({ workspaceId, userId: "user-1" });
    const error = await runOperation(principal, createTag, { name: "" }, { db: conn }).catch(
      (caught: unknown) => caught,
    );
    expect((error as OperationError).code).toBe("invalid_input");
    expect(await countTags(workspaceId)).toBe(0);
  });

  it("rejects an MCP call to an operation that is not classified now", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const principal = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["lists:write"],
      surface: "mcp",
    });
    const error = await runOperation(principal, listOnlyLater, { name: "x" }, { db: conn }).catch(
      (caught: unknown) => caught,
    );
    expect((error as OperationError).code).toBe("forbidden");
    await expect(
      runOperation(principal, createTag, { name: "x" }, { db: conn }),
    ).resolves.toMatchObject({ name: "x" });
  });
});
