import { describe, expect, it } from "vitest";
import { createApiKey, createWorkspace, testDb } from "../test/fixtures";
import { generateApiKey, hashApiKey, isApiKeyFormat, resolveApiKey } from "./api-keys";

describe("API keys", () => {
  it("makes prefixed random keys and stores only the hash", async () => {
    const a = await generateApiKey();
    const b = await generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(isApiKeyFormat(a.key)).toBe(true);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.prefix).toMatch(/^evk_.{8}$/);
    expect(a.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyHash).toBe(await hashApiKey(a.key));
    expect(a.keyHash).not.toContain(a.key.slice(4));
  });

  it("resolves a key to a REST principal with its scopes", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    // workspace:admin and unknown scopes are dropped: no key can hold them.
    const { key, id } = await createApiKey(conn, workspaceId, [
      "contacts:read",
      "workspace:admin",
      "made:up",
    ]);

    const principal = await resolveApiKey(conn, key, { surface: "rest" });
    expect(principal).toMatchObject({
      workspaceId,
      actorType: "api_key",
      actorId: String(id),
      apiKeyId: id,
      surface: "rest",
    });
    expect([...(principal?.scopes ?? [])]).toEqual(["contacts:read"]);

    const row = await conn.db
      .selectFrom("api_keys")
      .select("last_used_at")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.last_used_at).not.toBeNull();
  });

  it("rejects unknown, malformed, revoked, and expired keys", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const now = Date.now();
    const revoked = await createApiKey(conn, workspaceId, ["contacts:read"], { revoked_at: now });
    const expired = await createApiKey(conn, workspaceId, ["contacts:read"], {
      expires_at: now - 1,
    });
    const unknown = await generateApiKey();

    for (const token of [revoked.key, expired.key, unknown.key, "evk_short", "Bearer x", ""]) {
      expect(await resolveApiKey(conn, token, { surface: "rest" }), token).toBeNull();
    }
  });

  it("rejects a key whose workspace is archived", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const { key } = await createApiKey(conn, workspaceId, ["contacts:read"]);
    await conn.db
      .updateTable("workspaces")
      .set({ archived_at: Date.now() })
      .where("id", "=", workspaceId)
      .execute();
    expect(await resolveApiKey(conn, key, { surface: "rest" })).toBeNull();
  });
});
