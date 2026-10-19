import { registry } from "@envelopen/core";
import { describe, expect, it } from "vitest";
import committedDocument from "../../../web/src/api/openapi.json";
import {
  bearer,
  countRows,
  createApiKey,
  createTestApp,
  createWorkspace,
  jsonPost,
  ORIGIN,
  testDb,
  testRegistry,
} from "../../test/helpers";
import { purgeExpiredIdempotencyKeys } from "./idempotency";
import { createFixedWindowLimiter } from "./rate-limit";
import { buildOpenApiDocument, createApiRouter } from "./router";

type Json = Record<string, unknown>;

function sessionCookie(workspaceId: number, userId = "owner-1"): Record<string, string> {
  return { cookie: `test_session=${userId}:${workspaceId}` };
}

describe("registry parity", () => {
  it("gives every registry entry a route, an OpenAPI path, a scope, and an MCP classification", () => {
    for (const reg of [registry, testRegistry]) {
      const document = buildOpenApiDocument(reg);
      const routes = createApiRouter({ registry: reg }).routes;
      const documented: string[] = [];
      for (const [path, item] of Object.entries(document.paths ?? {})) {
        for (const [method, operation] of Object.entries(item as Record<string, Json>)) {
          documented.push(operation.operationId as string);
          const entry = reg.get(operation.operationId as string);
          expect(entry, `${method} ${path}`).toBeDefined();
          expect(entry?.path).toBe(path);
          expect(entry?.method).toBe(method);
          expect(operation["x-envelopen-scope"]).toBe(entry?.scope);
          expect(operation["x-envelopen-mcp"]).toBe(entry?.mcp.class);
        }
      }
      // The document has exactly the registry operations, no more and no fewer.
      expect(documented.sort()).toEqual(reg.operations.map((operation) => operation.id).sort());

      for (const operation of reg.operations) {
        const honoPath = operation.path.replaceAll(/\{([^}]+)\}/g, ":$1");
        const route = routes.find(
          (r) => r.method === operation.method.toUpperCase() && r.path === honoPath,
        );
        expect(route, operation.id).toBeDefined();
        expect(operation.scope, operation.id).toBeTruthy();
        expect(["now", "later", "never"]).toContain(operation.mcp.class);
      }
    }
  });

  it("matches the committed OpenAPI document that the web client types come from", () => {
    // Run `pnpm openapi` after changing the registry.
    expect(committedDocument).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it("serves the OpenAPI document without authentication", async () => {
    const res = await createTestApp().request("/openapi.json");
    expect(res.status).toBe(200);
    const document = (await res.json()) as Json;
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths as Json)).toContain("/test/lists");
  });
});

describe("authentication", () => {
  it("returns 401 without a session or key, and for an unknown key", async () => {
    const app = createTestApp();
    const none = await app.request("/workspace");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect(((await none.json()) as { error: Json }).error.code).toBe("unauthenticated");

    expect((await app.request("/workspace", { headers: bearer("evk_nope") })).status).toBe(401);
    expect(
      (await app.request("/workspace", { headers: { authorization: "Basic x" } })).status,
    ).toBe(401);
  });

  it("does not fall back to the session cookie when the API key is invalid", async () => {
    const workspaceId = await createWorkspace();
    const res = await createTestApp().request("/workspace", {
      headers: { ...bearer("evk_invalid"), ...sessionCookie(workspaceId) },
    });
    expect(res.status).toBe(401);
  });

  it("returns the workspace for a key with the scope", async () => {
    const workspaceId = await createWorkspace("Acme");
    const { key } = await createApiKey(workspaceId, ["stats:read"]);
    const res = await createTestApp().request("/workspace", { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: workspaceId, name: "Acme", trackingOpens: true });
  });
});

describe("scopes in the service layer", () => {
  it("returns 403 for a key without the required scope, and nothing is written", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["contacts:read"]);
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, bearer(key)),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "forbidden", details: { requiredScope: "lists:write" } },
    });
    expect(await countRows("lists", workspaceId)).toBe(0);
    expect(await countRows("audit_log", workspaceId)).toBe(0);
  });

  it("keeps owner-only operations away from every API key", async () => {
    const workspaceId = await createWorkspace();
    // Even a key row that lists workspace:admin does not get it.
    const { key } = await createApiKey(workspaceId, ["workspace:admin", "stats:read"]);
    const app = createTestApp();
    expect((await app.request("/audit-log", { headers: bearer(key) })).status).toBe(403);
    expect((await app.request("/audit-log", { headers: sessionCookie(workspaceId) })).status).toBe(
      200,
    );
  });

  it("writes an audit row with the actor, the surface, and the key id", async () => {
    const workspaceId = await createWorkspace();
    const { key, id } = await createApiKey(workspaceId, ["lists:write"]);
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, { ...bearer(key), "cf-connecting-ip": "198.51.100.7" }),
    );
    expect(res.status).toBe(201);
    const tag = (await res.json()) as { id: number };

    const rows = await testDb()
      .db.selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "api_key",
      actor_id: String(id),
      surface: "rest",
      api_key_id: id,
      action: "test_lists.create",
      target_type: "list",
      target_id: String(tag.id),
      ip: "198.51.100.7",
    });
  });

  it("does not audit reads", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["stats:read"]);
    await createTestApp().request("/workspace", { headers: bearer(key) });
    expect(await countRows("audit_log", workspaceId)).toBe(0);
  });
});

describe("input validation and errors", () => {
  it("returns 400 for an invalid body and writes nothing", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const res = await createTestApp().request("/test/lists", jsonPost({ name: "" }, bearer(key)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: Json }).error.code).toBe("invalid_input");
    expect(await countRows("lists", workspaceId)).toBe(0);
  });

  it("returns 415 for a body that is not JSON", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const res = await createTestApp().request("/test/lists", {
      method: "POST",
      headers: { ...bearer(key), "content-type": "text/plain" },
      body: "name=vip",
    });
    expect(res.status).toBe(415);
  });

  it("reads path parameters and maps not_found to 404", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["contacts:read", "lists:write"]);
    const app = createTestApp();
    const created = await app.request("/test/lists", jsonPost({ name: "a" }, bearer(key)));
    const tag = (await created.json()) as { id: number };

    const found = await app.request(`/test/lists/${tag.id}`, { headers: bearer(key) });
    expect(await found.json()).toEqual({ id: tag.id, name: "a" });
    const missing = await app.request(`/test/lists/${tag.id + 1000}`, { headers: bearer(key) });
    expect(missing.status).toBe(404);
  });

  it("does not show another workspace's rows", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const keyA = await createApiKey(workspaceA, ["contacts:read", "lists:write"]);
    const keyB = await createApiKey(workspaceB, ["contacts:read"]);
    const app = createTestApp();
    const created = await app.request("/test/lists", jsonPost({ name: "a" }, bearer(keyA.key)));
    const tag = (await created.json()) as { id: number };
    expect((await app.request(`/test/lists/${tag.id}`, { headers: bearer(keyB.key) })).status).toBe(
      404,
    );
  });

  it("returns a JSON 404 for an unknown API route", async () => {
    const workspaceId = await createWorkspace();
    const res = await createTestApp().request("/nothing", { headers: sessionCookie(workspaceId) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: Json }).error.code).toBe("not_found");
  });
});

describe("idempotency keys", () => {
  it("returns the first response for a reused key and does not repeat the write", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    const init = () => jsonPost({ name: "vip" }, { ...bearer(key), "idempotency-key": "abc-1" });

    const first = await app.request("/test/lists", init());
    const second = await app.request("/test/lists", init());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(await countRows("lists", workspaceId)).toBe(1);
    expect(await countRows("audit_log", workspaceId)).toBe(1);
  });

  it("rejects the same key with a different body", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    const headers = { ...bearer(key), "idempotency-key": "abc-2" };
    await app.request("/test/lists", jsonPost({ name: "one" }, headers));
    const res = await app.request("/test/lists", jsonPost({ name: "two" }, headers));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: Json }).error.code).toBe("idempotency_key_reused");
    expect(await countRows("lists", workspaceId)).toBe(1);
  });

  it("does not store a failed response, so a corrected retry runs", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    const headers = { ...bearer(key), "idempotency-key": "abc-3" };
    expect((await app.request("/test/lists", jsonPost({ name: "" }, headers))).status).toBe(400);
    expect(await countRows("idempotency_keys", workspaceId)).toBe(0);
    expect((await app.request("/test/lists", jsonPost({ name: "ok" }, headers))).status).toBe(201);
  });

  it("returns 409 while the first request with the key still runs", async () => {
    const workspaceId = await createWorkspace();
    const { key, id } = await createApiKey(workspaceId, ["lists:write"]);
    const body = JSON.stringify({ name: "vip" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await testDb()
      .db.insertInto("idempotency_keys")
      .values({
        workspace_id: workspaceId,
        principal_id: `api_key:${id}`,
        method: "POST",
        route: "/test/lists",
        key: "abc-4",
        request_hash: hash,
        expires_at: Date.now() + 60_000,
      })
      .execute();
    const res = await createTestApp().request("/test/lists", {
      method: "POST",
      headers: { ...bearer(key), "content-type": "application/json", "idempotency-key": "abc-4" },
      body,
    });
    expect(res.status).toBe(409);
    expect(await countRows("lists", workspaceId)).toBe(0);
  });

  it("runs again after the stored key expires", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    const headers = { ...bearer(key), "idempotency-key": "abc-5" };
    await app.request("/test/lists", jsonPost({ name: "vip" }, headers));
    await testDb()
      .db.updateTable("idempotency_keys")
      .set({ expires_at: Date.now() - 1 })
      .where("workspace_id", "=", workspaceId)
      .execute();
    const res = await app.request("/test/lists", jsonPost({ name: "vip" }, headers));
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(await countRows("lists", workspaceId)).toBe(2);
  });

  it("keeps keys separate per principal", async () => {
    const workspaceId = await createWorkspace();
    const a = await createApiKey(workspaceId, ["lists:write"]);
    const b = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    for (const { key } of [a, b]) {
      const res = await app.request(
        "/test/lists",
        jsonPost({ name: "vip" }, { ...bearer(key), "idempotency-key": "shared" }),
      );
      expect(res.headers.get("idempotent-replayed")).toBeNull();
    }
    expect(await countRows("lists", workspaceId)).toBe(2);
  });

  it("rejects a malformed key", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, { ...bearer(key), "idempotency-key": "has space" }),
    );
    expect(res.status).toBe(400);
    expect(await countRows("lists", workspaceId)).toBe(0);
  });

  it("purges only expired keys", async () => {
    const workspaceId = await createWorkspace();
    const values = (key: string, expiresAt: number) => ({
      workspace_id: workspaceId,
      principal_id: "user:x",
      method: "POST",
      route: "/test/lists",
      key,
      request_hash: "h",
      expires_at: expiresAt,
    });
    await testDb()
      .db.insertInto("idempotency_keys")
      .values([values("old", Date.now() - 1), values("new", Date.now() + 60_000)])
      .execute();
    await purgeExpiredIdempotencyKeys(testDb());
    const keys = await testDb()
      .db.selectFrom("idempotency_keys")
      .select("key")
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(keys.map((row) => row.key)).toEqual(["new"]);
  });
});

describe("origin check for sessions", () => {
  it("returns 403 for a cross-origin POST with a valid session cookie", async () => {
    const workspaceId = await createWorkspace();
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, { ...sessionCookie(workspaceId), origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: Json }).error.code).toBe("cross_origin");
    expect(await countRows("lists", workspaceId)).toBe(0);
  });

  it("returns 403 for a session POST without an Origin header", async () => {
    const workspaceId = await createWorkspace();
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, sessionCookie(workspaceId)),
    );
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin session POST and audits it as the user on the UI surface", async () => {
    const workspaceId = await createWorkspace();
    const res = await createTestApp().request(
      "/test/lists",
      jsonPost({ name: "vip" }, { ...sessionCookie(workspaceId, "owner-9"), origin: ORIGIN }),
    );
    expect(res.status).toBe(201);
    const audit = await testDb()
      .db.selectFrom("audit_log")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_type: "user", actor_id: "owner-9", surface: "ui" });
    expect(audit.api_key_id).toBeNull();
  });

  it("allows cross-origin GETs with a session, and API-key POSTs from any origin", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["lists:write"]);
    const app = createTestApp();
    const read = await app.request("/workspace", {
      headers: { ...sessionCookie(workspaceId), origin: "https://evil.example" },
    });
    expect(read.status).toBe(200);
    const write = await app.request(
      "/test/lists",
      jsonPost({ name: "vip" }, { ...bearer(key), origin: "https://elsewhere.example" }),
    );
    expect(write.status).toBe(201);
  });
});

describe("rate limit per API key", () => {
  it("returns 429 after the limit, per key, and leaves sessions alone", async () => {
    const workspaceId = await createWorkspace();
    const a = await createApiKey(workspaceId, ["stats:read"]);
    const b = await createApiKey(workspaceId, ["stats:read"]);
    const app = createTestApp({
      rateLimiter: createFixedWindowLimiter({ limit: 2, windowMs: 60_000 }),
    });

    const first = await app.request("/workspace", { headers: bearer(a.key) });
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    await app.request("/workspace", { headers: bearer(a.key) });
    const limited = await app.request("/workspace", { headers: bearer(a.key) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await app.request("/workspace", { headers: bearer(b.key) })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/workspace", { headers: sessionCookie(workspaceId) });
      expect(res.status).toBe(200);
    }
  });

  it("starts a new window after the window ends", async () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
    expect((await limiter.hit("k", 10_000)).allowed).toBe(true);
    expect((await limiter.hit("k", 10_500)).allowed).toBe(false);
    expect((await limiter.hit("k", 11_000)).allowed).toBe(true);
  });

  it("stays within its key bound", async () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) await limiter.hit(`k${i}`, 5_000);
    // The newest key is still tracked.
    expect((await limiter.hit("k9", 5_001)).allowed).toBe(false);
  });
});

describe("cursor pagination over REST", () => {
  async function addContacts(workspaceId: number, from: number, count: number) {
    await testDb()
      .db.insertInto("contacts")
      .values(
        Array.from({ length: count }, (_, i) => ({
          workspace_id: workspaceId,
          email: `p${from + i}@example.com`,
          consent_basis: "explicit_opt_in" as const,
          consent_source: "test",
          consent_at: 0,
          source: "test",
        })),
      )
      .execute();
  }

  it("returns each contact once while new contacts are inserted", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["contacts:read"]);
    const app = createTestApp();
    await addContacts(workspaceId, 0, 5);

    const seen: string[] = [];
    let cursor: string | null = null;
    let added = 5;
    do {
      const query = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
      const res = await app.request(`/test/contacts?${query}`, { headers: bearer(key) });
      expect(res.status).toBe(200);
      const page = (await res.json()) as { items: { email: string }[]; nextCursor: string | null };
      seen.push(...page.items.map((item) => item.email));
      if (added < 9) {
        await addContacts(workspaceId, added, 2);
        added += 2;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(Array.from({ length: added }, (_, i) => `p${i}@example.com`));
  });

  it("returns 400 for a forged cursor or a limit above the maximum", async () => {
    const workspaceId = await createWorkspace();
    const { key } = await createApiKey(workspaceId, ["contacts:read"]);
    const app = createTestApp();
    const forged = await app.request("/test/contacts?cursor=abc", { headers: bearer(key) });
    expect(forged.status).toBe(400);
    const tooMany = await app.request("/test/contacts?limit=1000", { headers: bearer(key) });
    expect(tooMany.status).toBe(400);
  });

  it("lists the audit log newest first with a cursor", async () => {
    const workspaceId = await createWorkspace();
    const app = createTestApp();
    const headers = { ...sessionCookie(workspaceId), origin: ORIGIN };
    for (const name of ["a", "b", "c"])
      await app.request("/test/lists", jsonPost({ name }, headers));

    const first = (await (
      await app.request("/audit-log?limit=2", { headers: sessionCookie(workspaceId) })
    ).json()) as { items: { id: number; action: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.action).toBe("test_lists.create");
    expect((first.items[0]?.id ?? 0) > (first.items[1]?.id ?? 0)).toBe(true);

    const second = (await (
      await app.request(`/audit-log?limit=2&cursor=${first.nextCursor}`, {
        headers: sessionCookie(workspaceId),
      })
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});
