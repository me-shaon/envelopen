import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb } from "../../../test/fixtures";
import { resolveApiKey } from "../../api-keys";
import { runOperation } from "../../executor";
import { apiKeyPrincipal, sessionPrincipal } from "../../principal";
import { apiKeysCreate, apiKeysList, apiKeysRevoke, resolveKeyScopes } from "./api-keys";

async function ownerOf(name = "Keys") {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, name);
  return { conn, principal: sessionPrincipal({ workspaceId, userId }) };
}

describe("API key scopes", () => {
  it("merges a preset and extra scopes in the canonical order", () => {
    expect(resolveKeyScopes("enrollment_sync", ["stats:read", "contacts:write"])).toEqual([
      "contacts:write",
      "stats:read",
    ]);
    expect(resolveKeyScopes(undefined, [])).toEqual([]);
    expect(resolveKeyScopes("agent_sender", undefined)).toContain("campaigns:send");
    expect(resolveKeyScopes("agent_editor", undefined)).not.toContain("campaigns:send");
  });
});

describe("api_keys operations", () => {
  it("returns the key once, stores only its hash, and resolves it", async () => {
    const { conn, principal } = await ownerOf();
    const created = await runOperation(
      principal,
      apiKeysCreate,
      { name: "CI", preset: "agent_read_only" },
      { db: conn },
    );
    expect(created.key).toMatch(/^evk_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.key.slice(0, 12));

    const row = await conn.db
      .selectFrom("api_keys")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.created_by_user_id).toBe(principal.actorId);

    const resolved = await resolveApiKey(conn, created.key, { surface: "rest" });
    expect(resolved?.workspaceId).toBe(principal.workspaceId);
    expect([...(resolved?.scopes ?? [])].sort()).toEqual([
      "campaigns:read",
      "contacts:read",
      "stats:read",
    ]);

    const list = await runOperation(principal, apiKeysList, {}, { db: conn });
    expect(JSON.stringify(list)).not.toContain(created.key);
    expect(list.items.map((item) => item.id)).toEqual([created.id]);
  });

  it("fails the key after a revoke and keeps the first revoke time", async () => {
    const { conn, principal } = await ownerOf();
    const created = await runOperation(
      principal,
      apiKeysCreate,
      { name: "x", scopes: ["stats:read"] },
      { db: conn },
    );
    const first = await runOperation(
      principal,
      apiKeysRevoke,
      { id: created.id },
      { db: conn, now: () => 1_000 },
    );
    expect(first.revokedAt).toBe(1_000);
    expect(await resolveApiKey(conn, created.key, { surface: "rest" })).toBeNull();
    const again = await runOperation(
      principal,
      apiKeysRevoke,
      { id: created.id },
      { db: conn, now: () => 2_000 },
    );
    expect(again.revokedAt).toBe(1_000);
  });

  it("stops resolving an expired key", async () => {
    const { conn, principal } = await ownerOf();
    const now = Date.now();
    const created = await runOperation(
      principal,
      apiKeysCreate,
      { name: "x", scopes: ["stats:read"], expiresAt: now + 60_000 },
      { db: conn, now: () => now },
    );
    expect(await resolveApiKey(conn, created.key, { surface: "rest", now })).not.toBeNull();
    expect(
      await resolveApiKey(conn, created.key, { surface: "rest", now: now + 60_000 }),
    ).toBeNull();
  });

  it("is never available to an API key or through MCP", async () => {
    const { conn, principal } = await ownerOf();
    const key = apiKeyPrincipal({
      workspaceId: principal.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read", "stats:read"],
      surface: "mcp",
    });
    await expect(runOperation(key, apiKeysList, {}, { db: conn })).rejects.toMatchObject({
      code: "forbidden",
    });
    const mcpOwner = { ...principal, surface: "mcp" as const };
    await expect(runOperation(mcpOwner, apiKeysList, {}, { db: conn })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("audits the creation with the scopes and never the key", async () => {
    const { conn, principal } = await ownerOf();
    const created = await runOperation(
      principal,
      apiKeysCreate,
      { name: "x", preset: "enrollment_sync" },
      { db: conn },
    );
    const audit = await conn.db
      .selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .where("action", "=", "api_keys.create")
      .executeTakeFirstOrThrow();
    expect(audit.target_id).toBe(String(created.id));
    expect(JSON.parse(audit.metadata ?? "{}")).toEqual({
      scopes: ["contacts:write"],
      preset: "enrollment_sync",
    });
    expect(audit.metadata).not.toContain(created.key);
  });
});
