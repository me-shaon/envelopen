import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  cookiesFrom,
  createOwner,
  freshIp,
  OWNER,
  ownerSession,
  resetAuthState,
  SETUP_TOKEN,
  signIn,
  testEnv,
} from "../../test/auth-helpers";
import { hashPassword, parseHash } from "../auth/pbkdf2-hasher";
import { setupTokenMatches } from "./first-run";

type Json = Record<string, unknown>;

beforeEach(resetAuthState);

async function errorCode(res: Response): Promise<unknown> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

async function credentialHash(userId: string): Promise<string | null> {
  return env.DB.prepare(
    `SELECT "password" FROM auth_account WHERE "userId" = ? AND "providerId" = 'credential'`,
  )
    .bind(userId)
    .first<string>("password");
}

describe("first-run screen stays closed", () => {
  for (const [label, token] of [
    ["unset", undefined],
    ["empty", ""],
    ["shorter than 32 characters", "x".repeat(31)],
  ] as const) {
    it(`returns 404 on every setup route when SETUP_TOKEN is ${label}`, async () => {
      const closed = testEnv({ SETUP_TOKEN: token });
      for (const path of ["/api/setup/check", "/api/setup/owner", "/api/setup/recover"]) {
        // Even the matching token does not open it.
        const res = await call(path, { env: closed, ip: freshIp(), body: { token } });
        expect(res.status, path).toBe(404);
        expect(await errorCode(res)).toBe("not_found");
      }
    });
  }

  it("opens at exactly 32 characters", async () => {
    const token = "y".repeat(32);
    const res = await call("/api/setup/check", {
      env: testEnv({ SETUP_TOKEN: token }),
      ip: freshIp(),
      body: { token },
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 once the owner exists", async () => {
    await createOwner();
    for (const path of ["/api/setup/check", "/api/setup/owner"]) {
      const res = await call(path, { ip: freshIp(), body: { token: SETUP_TOKEN } });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("setup token", () => {
  it("rejects a wrong, empty, or missing token", async () => {
    for (const body of [{ token: "wrong-token" }, { token: "" }, {}, { token: 42 }]) {
      const res = await call("/api/setup/check", { ip: freshIp(), body });
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(await errorCode(res)).toBe("invalid_setup_token");
    }
  });

  it("rejects a body that is not a JSON object", async () => {
    const res = await call("/api/setup/check", { ip: freshIp(), body: "token" });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin request", async () => {
    const res = await call("/api/setup/check", {
      ip: freshIp(),
      origin: "https://evil.example",
      body: { token: SETUP_TOKEN },
    });
    expect(res.status).toBe(403);
  });

  it("compares in constant time and only for an exact match", async () => {
    expect(await setupTokenMatches(SETUP_TOKEN, SETUP_TOKEN)).toBe(true);
    expect(await setupTokenMatches(SETUP_TOKEN, `${SETUP_TOKEN} `)).toBe(false);
    expect(await setupTokenMatches(SETUP_TOKEN, SETUP_TOKEN.slice(0, -1))).toBe(false);
    expect(await setupTokenMatches(SETUP_TOKEN, undefined)).toBe(false);
  });

  it("rejects the sixth attempt from one IP, even with the right token", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const res = await call("/api/setup/check", { ip, body: { token: `wrong-${i}` } });
      expect(res.status).toBe(401);
    }
    const blocked = await call("/api/setup/check", { ip, body: { token: SETUP_TOKEN } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is not affected.
    const other = await call("/api/setup/check", { ip: freshIp(), body: { token: SETUP_TOKEN } });
    expect(other.status).toBe(200);
  });
});

describe("binding and migration checks", () => {
  it("passes every check and returns the limits summary", async () => {
    const res = await call("/api/setup/check", { ip: freshIp(), body: { token: SETUP_TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      checks: { id: string; ok: boolean; hint: string | null }[];
      limits: { id: string; free: string; paid: string }[];
      guides: Json;
      auth: Json;
    };
    expect(body.ready).toBe(true);
    expect(body.checks.every((item) => item.ok && item.hint === null)).toBe(true);
    expect(body.checks.map((item) => item.id)).toEqual(
      expect.arrayContaining(["database", "migrations", "signing_key", "rate_limiter"]),
    );
    expect(body.limits.find((limit) => limit.id === "d1_writes")).toMatchObject({
      free: "100,000 per day",
    });
    expect(body.guides.platform).toBe("docs/guides/cloudflare-platform.md");
    expect(body.auth).toEqual({
      loginMode: "password",
      pbkdf2Iterations: 100_000,
      pbkdf2MaxIterations: 100_000,
    });
  });

  it("gives a fix hint for each missing secret or binding", async () => {
    const res = await call("/api/setup/check", {
      env: testEnv({ SIGNING_KEY: undefined, ENCRYPTION_KEY: "c2hvcnQ=", KV: undefined }),
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    const body = (await res.json()) as {
      ready: boolean;
      checks: { id: string; ok: boolean; hint: string | null }[];
    };
    expect(body.ready).toBe(false);
    const failed = Object.fromEntries(
      body.checks.filter((item) => !item.ok).map((item) => [item.id, item.hint]),
    );
    expect(Object.keys(failed).sort()).toEqual(["encryption_key", "kv", "signing_key"]);
    expect(failed.signing_key).toContain("openssl rand -base64 32");
    expect(failed.kv).toContain("KV");
  });

  it("reports migrations that did not run", async () => {
    // A database that answers but has no tables.
    const empty = {
      prepare: () => ({
        bind: () => {
          throw new Error("no such table");
        },
        first: async () => 1,
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database;
    const res = await call("/api/setup/check", {
      env: testEnv({ DB: empty }),
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    const body = (await res.json()) as { checks: { id: string; ok: boolean; hint: string }[] };
    const migrations = body.checks.find((item) => item.id === "migrations");
    expect(migrations?.ok).toBe(false);
    expect(migrations?.hint).toContain("wrangler d1 migrations apply DB --remote");
    expect(migrations?.hint).toContain("auth_user");
  });

  it("does not create the owner while a check fails", async () => {
    const res = await call("/api/setup/owner", {
      env: testEnv({ ENCRYPTION_KEY: undefined }),
      ip: freshIp(),
      body: { token: SETUP_TOKEN, ...OWNER },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("setup_checks_failed");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auth_user").first("n")).toBe(0);
  });
});

describe("owner creation", () => {
  it("creates the owner, the first workspace, and the owner membership", async () => {
    const owner = await createOwner();
    expect(owner.loginMode).toBe("password");
    expect(owner.passkeyEnrollment).toBeNull();

    const membership = await env.DB.prepare(
      "SELECT m.role, w.name, u.email FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?",
    )
      .bind(owner.workspaceId)
      .first();
    expect(membership).toEqual({ role: "owner", name: OWNER.workspaceName, email: OWNER.email });
    expect(parseHash((await credentialHash(owner.userId)) ?? "")?.iterations).toBe(100_000);

    const audit = await env.DB.prepare(
      "SELECT action, actor_id FROM audit_log WHERE workspace_id = ? AND action = 'setup.owner_created'",
    )
      .bind(owner.workspaceId)
      .first();
    expect(audit).toEqual({ action: "setup.owner_created", actor_id: owner.userId });
  });

  it("requires a password of at least 12 characters in password mode", async () => {
    for (const password of [undefined, "short"]) {
      const res = await call("/api/setup/owner", {
        ip: freshIp(),
        body: { token: SETUP_TOKEN, email: OWNER.email, name: "O", workspaceName: "W", password },
      });
      expect(res.status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auth_user").first("n")).toBe(0);
  });

  it("rejects an invalid email and normalizes a valid one", async () => {
    const bad = await call("/api/setup/owner", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, ...OWNER, email: "not-an-email" },
    });
    expect(bad.status).toBe(400);
    const good = await call("/api/setup/owner", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, ...OWNER, email: "  Owner@Example.COM " },
    });
    expect(good.status).toBe(201);
    expect(await env.DB.prepare("SELECT email FROM users").first("email")).toBe(OWNER.email);
  });

  it("lets only one of two concurrent setups win", async () => {
    const attempt = (email: string) =>
      call("/api/setup/owner", {
        ip: freshIp(),
        body: { token: SETUP_TOKEN, ...OWNER, email },
      });
    const results = await Promise.all([attempt("a@example.com"), attempt("b@example.com")]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 404]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auth_user").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM users").first("n")).toBe(1);
  });

  it("reaches a signed-in owner with one workspace", async () => {
    const owner = await createOwner();
    const res = await signIn(OWNER.password);
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token"));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const workspace = await call("/api/workspace", { headers: { cookie: cookiesFrom(res) } });
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      id: owner.workspaceId,
      name: OWNER.workspaceName,
    });
  });

  it("does not allow sign-up", async () => {
    await createOwner();
    const res = await call("/api/auth/sign-up/email", {
      ip: freshIp(),
      body: { email: "intruder@example.com", password: "another-long-password", name: "X" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auth_user").first("n")).toBe(1);
  });
});

describe("password reset with the setup token", () => {
  it("sets a new password, ends existing sessions, and audits the reset", async () => {
    const owner = await createOwner();
    const oldCookie = await ownerSession();

    const res = await call("/api/setup/recover", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, password: "the-new-long-password" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ loginMode: "password", passkeyEnrollment: null });

    expect((await signIn(OWNER.password)).status).toBe(401);
    expect((await signIn("the-new-long-password")).status).toBe(200);
    expect((await call("/api/workspace", { headers: { cookie: oldCookie } })).status).toBe(401);
    const audit = await env.DB.prepare(
      "SELECT actor_type, target_id FROM audit_log WHERE action = 'setup.password_reset' AND target_id = ?",
    )
      .bind(owner.userId)
      .first();
    expect(audit).toEqual({ actor_type: "system", target_id: owner.userId });
  });

  it("fails without the right token and keeps the password", async () => {
    await createOwner();
    for (const token of ["wrong", "", undefined]) {
      const res = await call("/api/setup/recover", {
        ip: freshIp(),
        body: { token, password: "the-new-long-password" },
      });
      expect(res.status).toBe(401);
    }
    expect((await signIn(OWNER.password)).status).toBe(200);
  });

  it("returns 404 before the owner exists, and requires a valid password", async () => {
    const before = await call("/api/setup/recover", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, password: "the-new-long-password" },
    });
    expect(before.status).toBe(404);

    await createOwner();
    const short = await call("/api/setup/recover", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, password: "short" },
    });
    expect(short.status).toBe(400);
  });

  it("clears the email's failed-login count", async () => {
    await createOwner();
    for (let i = 0; i < 5; i++) await signIn(`wrong-password-${i}`);
    expect((await signIn(OWNER.password)).status).toBe(429);
    await call("/api/setup/recover", {
      ip: freshIp(),
      body: { token: SETUP_TOKEN, password: "the-new-long-password" },
    });
    expect((await signIn("the-new-long-password")).status).toBe(200);
  });
});

describe("login", () => {
  it("rehashes a password with old parameters at login", async () => {
    const owner = await createOwner();
    const old = await hashPassword(OWNER.password, 2_000);
    await env.DB.prepare(
      `UPDATE auth_account SET "password" = ? WHERE "userId" = ? AND "providerId" = 'credential'`,
    )
      .bind(old, owner.userId)
      .run();

    expect((await signIn(OWNER.password)).status).toBe(200);
    const updated = await credentialHash(owner.userId);
    expect(updated).not.toBe(old);
    expect(parseHash(updated ?? "")?.iterations).toBe(100_000);
    // The new hash still verifies.
    expect((await signIn(OWNER.password)).status).toBe(200);
  });

  it("does not rehash after a failed login", async () => {
    const owner = await createOwner();
    const old = await hashPassword(OWNER.password, 2_000);
    await env.DB.prepare(`UPDATE auth_account SET "password" = ? WHERE "userId" = ?`)
      .bind(old, owner.userId)
      .run();
    expect((await signIn("a-wrong-password")).status).toBe(401);
    expect(await credentialHash(owner.userId)).toBe(old);
  });

  it("rejects the sixth failed login from one IP within the window", async () => {
    await createOwner();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      // Different emails, so only the IP counter reaches the limit.
      const res = await call("/api/auth/sign-in/email", {
        ip,
        body: { email: `someone${i}@example.com`, password: "a-wrong-password" },
      });
      expect(res.status).toBe(401);
    }
    const sixth = await signIn(OWNER.password, { ip });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    // The same password from another IP works.
    expect((await signIn(OWNER.password)).status).toBe(200);
  });

  it("rejects the sixth failed login for one email from many IPs", async () => {
    await createOwner();
    for (let i = 0; i < 5; i++) expect((await signIn(`wrong-${i}`)).status).toBe(401);
    expect((await signIn(OWNER.password)).status).toBe(429);
  });

  it("does not count successful logins", async () => {
    await createOwner();
    const ip = freshIp();
    for (let i = 0; i < 7; i++) expect((await signIn(OWNER.password, { ip })).status).toBe(200);
  });

  it("rejects a cross-origin sign-in", async () => {
    await createOwner();
    const res = await call("/api/auth/sign-in/email", {
      ip: freshIp(),
      origin: "https://evil.example",
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(res.status).toBe(403);
  });
});
