import { describe, expect, it } from "vitest";
import {
  createApiKey,
  createOwnedWorkspace,
  createUser,
  memorySettingsCache,
  testDb,
} from "../../test/fixtures";
import { resolveApiKey } from "../api-keys";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { sessionPrincipal } from "../principal";
import { registry } from "../registry";
import { API_KEY_SCOPES } from "../scopes";
import {
  DEFAULT_SOURCE_URL,
  isHttpsUrl,
  readSourceUrl,
  SOURCE_URL_SETTING,
  settingsGet,
  settingsUpdate,
} from "./operations";

// Deployment settings (KTD16, R6): the source link of the deployment.

async function owner() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Settings");
  await conn.db.deleteFrom("system_settings").where("key", "=", SOURCE_URL_SETTING).execute();
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail.");
}

describe("source link setting", () => {
  it("defaults to the upstream repository", async () => {
    const { conn, principal } = await owner();
    const settings = await runOperation(principal, settingsGet, {}, { db: conn });
    expect(settings).toEqual({
      sourceUrl: DEFAULT_SOURCE_URL,
      defaultSourceUrl: "https://github.com/me-shaon/envelopen",
    });
    expect(await readSourceUrl(conn)).toBe(DEFAULT_SOURCE_URL);
  });

  it("stores a custom https URL, writes it through the cache, and audits the change", async () => {
    const { conn, principal, workspaceId } = await owner();
    const cache = memorySettingsCache();
    const url = "https://git.example.com/acme/envelopen";
    const updated = await runOperation(
      principal,
      settingsUpdate,
      { sourceUrl: ` ${url} ` },
      { db: conn, services: { settingsCache: cache } },
    );
    expect(updated.sourceUrl).toBe(url);
    expect(cache.entries.get(SOURCE_URL_SETTING)).toBe(url);
    expect((await runOperation(principal, settingsGet, {}, { db: conn })).sourceUrl).toBe(url);
    // A cold cache reads D1 and fills the cache.
    const cold = memorySettingsCache();
    expect(await readSourceUrl(conn, cold)).toBe(url);
    expect(cold.entries.get(SOURCE_URL_SETTING)).toBe(url);

    const audit = await conn.db
      .selectFrom("audit_log")
      .select(["action", "target_type"])
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(audit).toEqual([{ action: "settings.update", target_type: "deployment_settings" }]);
  });

  it("reads the cache first, and ignores a cached value that is not https", async () => {
    const { conn } = await owner();
    const cache = memorySettingsCache();
    cache.entries.set(SOURCE_URL_SETTING, "https://cached.example.com/repo");
    expect(await readSourceUrl(conn, cache)).toBe("https://cached.example.com/repo");
    cache.entries.set(SOURCE_URL_SETTING, "javascript:alert(1)");
    expect(await readSourceUrl(conn, cache)).toBe(DEFAULT_SOURCE_URL);
  });

  it("reads D1 when the cache fails", async () => {
    const { conn } = await owner();
    const broken = {
      get: async () => {
        throw new Error("KV is down");
      },
      put: async () => {
        throw new Error("KV is down");
      },
    };
    expect(await readSourceUrl(conn, broken)).toBe(DEFAULT_SOURCE_URL);
  });

  it.each([
    "http://github.com/acme/envelopen",
    "javascript:alert(1)",
    "JavaScript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/src",
    "//github.com/acme/envelopen",
    "github.com/acme/envelopen",
    "https://user:secret@github.com/acme",
    "https://exa mple.com/repo",
    "",
  ])("rejects %j with a field error and keeps the stored link", async (sourceUrl) => {
    const { conn, principal } = await owner();
    const error = await rejection(
      runOperation(principal, settingsUpdate, { sourceUrl }, { db: conn }),
    );
    expect(isOperationError(error) && error.code).toBe("invalid_input");
    const issues = (error as { details: { path: unknown[]; message: string }[] }).details;
    expect(issues[0]?.path).toEqual(["sourceUrl"]);
    expect(issues[0]?.message).toMatch(/https|Enter/);
    expect((await runOperation(principal, settingsGet, {}, { db: conn })).sourceUrl).toBe(
      DEFAULT_SOURCE_URL,
    );
  });

  it("accepts only https URLs", () => {
    expect(isHttpsUrl("https://github.com/me-shaon/envelopen")).toBe(true);
    expect(isHttpsUrl("http://github.com/me-shaon/envelopen")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
  });

  it("is owner only: an API key with every key scope cannot read or change it", async () => {
    const { conn, workspaceId } = await owner();
    const created = await createApiKey(conn, workspaceId, API_KEY_SCOPES);
    const principal = await resolveApiKey(conn, created.key, { surface: "rest" });
    if (!principal) throw new Error("The key did not resolve.");
    for (const [operation, input] of [
      [settingsUpdate, { sourceUrl: "https://evil.example.com" }],
      [settingsGet, {}],
    ] as const) {
      const error = await rejection(runOperation(principal, operation, input, { db: conn }));
      expect(isOperationError(error) && error.code).toBe("forbidden");
    }
    expect(await readSourceUrl(conn)).toBe(DEFAULT_SOURCE_URL);
  });

  it("is in the registry with the session-only scope and never through MCP", () => {
    for (const id of ["settings.get", "settings.update"]) {
      const operation = registry.get(id);
      expect(operation?.scope).toBe("workspace:admin");
      expect(operation?.mcp.class).toBe("never");
    }
  });
});
