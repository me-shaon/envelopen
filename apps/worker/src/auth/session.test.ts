import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createOwner, ownerSession, resetAuthState } from "../../test/auth-helpers";

// End-to-end: a Better Auth session becomes the owner's Principal, and the owner manages
// workspaces and API keys through the generated REST API.

type Json = Record<string, unknown>;

beforeEach(resetAuthState);

async function setup() {
  const owner = await createOwner();
  const cookie = await ownerSession();
  return { owner, cookie };
}

describe("session principal", () => {
  it("returns 401 without a session and for a forged cookie", async () => {
    await createOwner();
    expect((await call("/api/workspace")).status).toBe(401);
    const forged = await call("/api/workspace", {
      headers: { cookie: "__Secure-envelopen.session_token=forged.value" },
    });
    expect(forged.status).toBe(401);
  });

  it("gives the owner every scope, workspace:admin included", async () => {
    const { cookie } = await setup();
    expect((await call("/api/audit-log", { headers: { cookie } })).status).toBe(200);
    expect((await call("/api/api-keys", { headers: { cookie } })).status).toBe(200);
  });

  it("picks the workspace from the X-Envelopen-Workspace header", async () => {
    const { owner, cookie } = await setup();
    const created = await call("/api/workspaces", {
      headers: { cookie },
      body: { name: "Second" },
    });
    expect(created.status).toBe(201);
    const second = (await created.json()) as { id: number };

    const picked = await call("/api/workspace", {
      headers: { cookie, "x-envelopen-workspace": String(second.id) },
    });
    expect(await picked.json()).toMatchObject({ id: second.id, name: "Second" });
    // Without the header: the oldest workspace.
    const fallback = await call("/api/workspace", { headers: { cookie } });
    expect(await fallback.json()).toMatchObject({ id: owner.workspaceId });

    const unknown = await call("/api/workspace", {
      headers: { cookie, "x-envelopen-workspace": "999999" },
    });
    expect(unknown.status).toBe(404);
    const invalid = await call("/api/workspace", {
      headers: { cookie, "x-envelopen-workspace": "abc" },
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects a cross-origin write with a valid session", async () => {
    const { cookie } = await setup();
    const res = await call("/api/workspaces", {
      headers: { cookie },
      origin: "https://evil.example",
      body: { name: "Nope" },
    });
    expect(res.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM workspaces WHERE name = 'Nope'").first("n"),
    ).toBe(0);
  });

  it("ends the session at sign-out", async () => {
    const { cookie } = await setup();
    const out = await call("/api/auth/sign-out", { headers: { cookie }, body: {} });
    expect(out.status).toBe(200);
    expect((await call("/api/workspace", { headers: { cookie } })).status).toBe(401);
  });
});

describe("workspaces", () => {
  it("creates, renames, lists, and archives workspaces", async () => {
    const { owner, cookie } = await setup();
    const created = await call("/api/workspaces", {
      headers: { cookie },
      body: { name: " Side " },
    });
    const side = (await created.json()) as { id: number; name: string };
    expect(side.name).toBe("Side");

    const renamed = await call(`/api/workspaces/${side.id}`, {
      method: "PATCH",
      headers: { cookie },
      body: { name: "Side project" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: side.id, name: "Side project" });

    const archived = await call(`/api/workspaces/${side.id}/archive`, {
      headers: { cookie },
      body: {},
    });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as Json).archivedAt).toEqual(expect.any(Number));

    const list = (await (await call("/api/workspaces", { headers: { cookie } })).json()) as {
      items: { id: number; archivedAt: number | null }[];
    };
    expect(list.items.map((item) => [item.id, item.archivedAt === null])).toEqual([
      [owner.workspaceId, true],
      [side.id, false],
    ]);
    // An archived workspace cannot be picked.
    const picked = await call("/api/workspace", {
      headers: { cookie, "x-envelopen-workspace": String(side.id) },
    });
    expect(picked.status).toBe(404);
  });

  it("refuses to archive the last active workspace", async () => {
    const { owner, cookie } = await setup();
    const res = await call(`/api/workspaces/${owner.workspaceId}/archive`, {
      headers: { cookie },
      body: {},
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for a workspace that the owner is not a member of", async () => {
    const { cookie } = await setup();
    const other = await env.DB.prepare(
      "INSERT INTO workspaces (name) VALUES ('Other') RETURNING id",
    ).first<number>("id");
    const res = await call(`/api/workspaces/${other}`, {
      method: "PATCH",
      headers: { cookie },
      body: { name: "Mine now" },
    });
    expect(res.status).toBe(404);
  });

  it("audits workspace changes", async () => {
    const { owner, cookie } = await setup();
    await call("/api/workspaces", { headers: { cookie }, body: { name: "Audited" } });
    const row = await env.DB.prepare(
      "SELECT actor_type, actor_id, surface FROM audit_log WHERE action = 'workspaces.create' AND actor_id = ?",
    )
      .bind(owner.userId)
      .first();
    expect(row).toEqual({ actor_type: "user", actor_id: owner.userId, surface: "ui" });
  });
});

describe("API keys", () => {
  it("shows a new key once, lists it without the key, and accepts it", async () => {
    const { cookie } = await setup();
    const created = await call("/api/api-keys", {
      headers: { cookie, "idempotency-key": "key-1" },
      body: { name: "Agent", preset: "agent_read_only" },
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: number; key: string; scopes: string[] };
    expect(key.key).toMatch(/^evk_/);
    expect(key.scopes).toEqual(["contacts:read", "campaigns:read", "stats:read"]);
    // The response with the key is never stored for an idempotent replay.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM idempotency_keys").first("n")).toBe(0);

    const list = await call("/api/api-keys", { headers: { cookie } });
    const text = await list.text();
    expect(text).not.toContain(key.key);
    expect(JSON.parse(text).items).toHaveLength(1);

    const used = await call("/api/workspace", { headers: { authorization: `Bearer ${key.key}` } });
    expect(used.status).toBe(200);
  });

  it("fails the next request after a key is revoked", async () => {
    const { cookie } = await setup();
    const created = await call("/api/api-keys", {
      headers: { cookie },
      body: { name: "Sync", preset: "enrollment_sync", scopes: ["stats:read"] },
    });
    const key = (await created.json()) as { id: number; key: string };
    const bearer = { authorization: `Bearer ${key.key}` };
    expect((await call("/api/workspace", { headers: bearer })).status).toBe(200);

    const revoked = await call(`/api/api-keys/${key.id}/revoke`, { headers: { cookie }, body: {} });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as Json).revokedAt).toEqual(expect.any(Number));
    expect((await call("/api/workspace", { headers: bearer })).status).toBe(401);
  });

  it("never lets a key manage keys or workspaces", async () => {
    const { cookie } = await setup();
    const created = await call("/api/api-keys", {
      headers: { cookie },
      body: { name: "All", scopes: ["contacts:read", "stats:read", "campaigns:send"] },
    });
    const { key } = (await created.json()) as { key: string };
    const bearer = { authorization: `Bearer ${key}` };
    expect((await call("/api/api-keys", { headers: bearer })).status).toBe(403);
    expect(
      (
        await call("/api/api-keys", {
          headers: bearer,
          body: { name: "x", preset: "agent_sender" },
        })
      ).status,
    ).toBe(403);
    expect((await call("/api/workspaces", { headers: bearer, body: { name: "x" } })).status).toBe(
      403,
    );
  });

  it("rejects a session-only scope, an empty scope list, and a past expiry", async () => {
    const { cookie } = await setup();
    for (const body of [
      { name: "x", scopes: ["workspace:admin"] },
      { name: "x" },
      { name: "x", scopes: [] },
      { name: "x", preset: "agent_editor", expiresAt: 1 },
    ]) {
      const res = await call("/api/api-keys", { headers: { cookie }, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("does not show another workspace's keys", async () => {
    const { cookie } = await setup();
    const second = (await (
      await call("/api/workspaces", { headers: { cookie }, body: { name: "B" } })
    ).json()) as { id: number };
    const created = await call("/api/api-keys", {
      headers: { cookie, "x-envelopen-workspace": String(second.id) },
      body: { name: "In B", preset: "agent_read_only" },
    });
    const key = (await created.json()) as { id: number };
    const listA = (await (await call("/api/api-keys", { headers: { cookie } })).json()) as {
      items: unknown[];
    };
    expect(listA.items).toHaveLength(0);
    const revokeFromA = await call(`/api/api-keys/${key.id}/revoke`, {
      headers: { cookie },
      body: {},
    });
    expect(revokeFromA.status).toBe(404);
  });

  it("lists the scopes and presets for the key form", async () => {
    const { cookie } = await setup();
    const res = await call("/api/api-keys/presets", { headers: { cookie } });
    const body = (await res.json()) as {
      scopes: { scope: string }[];
      presets: { id: string; scopes: string[] }[];
    };
    expect(body.scopes.map((s) => s.scope)).not.toContain("workspace:admin");
    expect(body.presets.map((p) => p.id)).toEqual([
      "enrollment_sync",
      "agent_read_only",
      "agent_editor",
      "agent_sender",
    ]);
    // Only the sender preset can send.
    for (const preset of body.presets) {
      expect(preset.scopes.includes("campaigns:send")).toBe(preset.id === "agent_sender");
    }
  });
});
