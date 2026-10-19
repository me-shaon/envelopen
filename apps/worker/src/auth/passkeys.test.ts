import { env } from "cloudflare:workers";
import { createDb } from "@envelopen/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  call,
  cookiesFrom,
  createOwner,
  freshIp,
  OWNER,
  resetAuthState,
  SETUP_TOKEN,
  testEnv,
} from "../../test/auth-helpers";
import { createAuth } from "./better-auth";
import {
  consumePasskeyEnrollment,
  createPasskeyEnrollment,
  createPasskeyPlugin,
  findPasskeyEnrollment,
  loginModeFor,
} from "./passkeys";

// A WebAuthn ceremony needs an authenticator, which Vitest does not have. These tests
// cover the mode selection, the routes, the enrollment tokens, and the recovery rules.
// The signed attestation and assertion steps need a browser (see the report for U4).

const PASSKEY_ENV = testEnv({ PBKDF2_ITERATIONS: "50000" });

beforeEach(resetAuthState);

async function authContext() {
  const auth = await createAuth({ env: PASSKEY_ENV, origin: APP_ORIGIN, d1: createDb(env).d1 });
  return auth.$context;
}

function count(sql: string, ...values: unknown[]): Promise<number | null> {
  return env.DB.prepare(sql)
    .bind(...values)
    .first<number>("n");
}

describe("login mode", () => {
  it("selects passkeys below the Workers PBKDF2 maximum", () => {
    expect(loginModeFor(100_000)).toBe("password");
    expect(loginModeFor(99_999)).toBe("passkey");
    expect(loginModeFor(10_000)).toBe("passkey");
  });

  it("tells the login page which method to show", async () => {
    const password = await call("/api/auth/mode");
    expect(await password.json()).toEqual({ loginMode: "password" });
    const passkey = await call("/api/auth/mode", { env: PASSKEY_ENV });
    expect(await passkey.json()).toEqual({ loginMode: "passkey" });
    // An out-of-range setting is clamped to the maximum: password mode.
    const clamped = await call("/api/auth/mode", {
      env: testEnv({ PBKDF2_ITERATIONS: "500000" }),
    });
    expect(await clamped.json()).toEqual({ loginMode: "password" });
  });

  it("reports the mode on the first-run screen", async () => {
    const res = await call("/api/setup/check", {
      env: PASSKEY_ENV,
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    expect(((await res.json()) as { auth: unknown }).auth).toMatchObject({
      loginMode: "passkey",
      pbkdf2Iterations: 50_000,
    });
  });
});

describe("first-run in passkey mode", () => {
  it("creates the owner without a password and returns an enrollment token", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    expect(owner.loginMode).toBe("passkey");
    expect(owner.passkeyEnrollment?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(owner.passkeyEnrollment?.expiresAt).toBeGreaterThan(Date.now());
    expect(
      await count(`SELECT count(*) AS n FROM auth_account WHERE "userId" = ?`, owner.userId),
    ).toBe(0);
    // The database keeps only the token's hash.
    expect(
      await count(
        "SELECT count(*) AS n FROM auth_verification WHERE instr(identifier, ?) > 0",
        owner.passkeyEnrollment?.token,
      ),
    ).toBe(0);
  });

  it("starts a passkey registration only with a valid enrollment token", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    const path = "/api/auth/passkey/generate-register-options";

    const none = await call(path, { env: PASSKEY_ENV });
    expect(none.status).toBe(401);
    const wrong = await call(`${path}?context=${"0".repeat(64)}`, { env: PASSKEY_ENV });
    expect(wrong.status).toBe(401);

    const res = await call(`${path}?context=${owner.passkeyEnrollment?.token}`, {
      env: PASSKEY_ENV,
    });
    expect(res.status).toBe(200);
    const options = (await res.json()) as {
      challenge: string;
      rp: { id: string; name: string };
      user: { name: string };
    };
    expect(options.rp).toEqual({ id: "envelopen.test", name: "Envelopen" });
    expect(options.user.name).toBe(OWNER.email);
    expect(options.challenge.length).toBeGreaterThan(20);
    const challengeCookie = res.headers.getSetCookie().find((c) => c.includes("passkey"));
    expect(challengeCookie).toMatch(/HttpOnly/i);
    expect(challengeCookie).toMatch(/Secure/i);

    // A response that no authenticator signed fails, and stores no passkey.
    const verify = await call("/api/auth/passkey/verify-registration", {
      env: PASSKEY_ENV,
      headers: { cookie: cookiesFrom(res) },
      body: { response: { id: "x", rawId: "x", type: "public-key", response: {} } },
    });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    expect(await count("SELECT count(*) AS n FROM auth_passkey")).toBe(0);
  });

  it("rejects an expired enrollment token", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare(`UPDATE auth_verification SET "expiresAt" = ?`).bind(past).run();
    const res = await call(
      `/api/auth/passkey/generate-register-options?context=${owner.passkeyEnrollment?.token}`,
      { env: PASSKEY_ENV },
    );
    expect(res.status).toBe(401);
  });

  it("serves the passkey login routes", async () => {
    await createOwner({ env: PASSKEY_ENV, password: null });
    const options = await call("/api/auth/passkey/generate-authenticate-options", {
      env: PASSKEY_ENV,
    });
    expect(options.status).toBe(200);
    expect(((await options.json()) as { rpId: string }).rpId).toBe("envelopen.test");
  });

  it("counts failed passkey logins toward the IP limit", async () => {
    await createOwner({ env: PASSKEY_ENV, password: null });
    const ip = freshIp();
    const attempt = () =>
      call("/api/auth/passkey/verify-authentication", {
        env: PASSKEY_ENV,
        ip,
        body: { response: { id: "x" } },
      });
    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(429);
    }
    expect((await attempt()).status).toBe(429);
  });
});

describe("enrollment tokens", () => {
  it("are single use", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    const context = await authContext();
    const { token } = await createPasskeyEnrollment(context, owner.userId, "setup");
    expect(await findPasskeyEnrollment(context, token)).toEqual({
      userId: owner.userId,
      purpose: "setup",
    });
    expect(await consumePasskeyEnrollment(context, token)).not.toBeNull();
    expect(await consumePasskeyEnrollment(context, token)).toBeNull();
    expect(await findPasskeyEnrollment(context, token)).toBeNull();
  });
});

describe("setup-token recovery in passkey mode", () => {
  it("returns a recovery enrollment that replaces the old passkeys and sessions", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    const context = await authContext();
    // An existing passkey and session, as after a real registration.
    await env.DB.prepare(
      `INSERT INTO auth_passkey (id, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt")
       VALUES ('old', 'pk', ?, 'cred-old', 0, 'singleDevice', 0, ?)`,
    )
      .bind(owner.userId, new Date().toISOString())
      .run();
    await context.internalAdapter.createSession(owner.userId);
    expect(
      await count(`SELECT count(*) AS n FROM auth_session WHERE "userId" = ?`, owner.userId),
    ).toBe(1);

    const recover = await call("/api/setup/recover", {
      env: PASSKEY_ENV,
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    expect(recover.status).toBe(200);
    const body = (await recover.json()) as {
      loginMode: string;
      passkeyEnrollment: { token: string };
    };
    expect(body.loginMode).toBe("passkey");
    expect(await findPasskeyEnrollment(context, body.passkeyEnrollment.token)).toMatchObject({
      purpose: "recovery",
    });

    // The plugin calls afterVerification after the authenticator's response verifies.
    // Here it is called directly with the recovery context.
    const plugin = createPasskeyPlugin(APP_ORIGIN);
    const afterVerification = plugin.options?.registration?.afterVerification;
    if (!afterVerification) throw new Error("afterVerification is not set");
    const args = {
      ctx: { context },
      context: body.passkeyEnrollment.token,
      user: { id: owner.userId, name: OWNER.email },
    } as unknown as Parameters<typeof afterVerification>[0];

    expect(await afterVerification(args)).toEqual({ userId: owner.userId });
    expect(
      await count(`SELECT count(*) AS n FROM auth_passkey WHERE "userId" = ?`, owner.userId),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM auth_session WHERE "userId" = ?`, owner.userId),
    ).toBe(0);
    // The enrollment is used up.
    await expect(afterVerification(args)).rejects.toThrow();
  });

  it("does not let an enrollment register a passkey for another user", async () => {
    const owner = await createOwner({ env: PASSKEY_ENV, password: null });
    const context = await authContext();
    const { token } = await createPasskeyEnrollment(context, owner.userId, "setup");
    const afterVerification =
      createPasskeyPlugin(APP_ORIGIN).options?.registration?.afterVerification;
    if (!afterVerification) throw new Error("afterVerification is not set");
    const args = {
      ctx: { context },
      context: token,
      user: { id: "someone-else", name: "x" },
    } as unknown as Parameters<typeof afterVerification>[0];
    await expect(afterVerification(args)).rejects.toThrow();
  });

  it("still requires the setup token", async () => {
    await createOwner({ env: PASSKEY_ENV, password: null });
    const res = await call("/api/setup/recover", {
      env: PASSKEY_ENV,
      ip: freshIp(),
      body: { token: "wrong" },
    });
    expect(res.status).toBe(401);
    expect(await count("SELECT count(*) AS n FROM auth_verification")).toBe(1);
  });
});
