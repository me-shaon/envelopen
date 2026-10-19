import { PLAN_LIMITS, type PlanLimit } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  type AuthSettings,
  authSettings,
  createAuth,
  isUsableKey,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../auth/better-auth";
import { createPasskeyEnrollment } from "../auth/passkeys";
import { PBKDF2_MAX_ITERATIONS, timingSafeEqualBytes } from "../auth/pbkdf2-hasher";
import { type AttemptLimiter, attemptKeys, clientIp, SETUP_RULE } from "../auth/rate-limit-do";
import { defaultLimiter, tooManyAttempts } from "../auth/routes";
import { AUTH_TABLES } from "../auth/schema-options";

// First-run screen and setup-token recovery (KTD6, R2, R3, R74). Mounted at /api/setup.
//
//   POST /api/setup/check    { token }  Binding and migration checks, plan limits, login mode.
//   POST /api/setup/owner    { token, email, name, workspaceName, password? }
//   POST /api/setup/recover  { token, password? }
//
// Every route answers 404, the same as an unknown API route, when SETUP_TOKEN is unset
// or shorter than 32 characters. The setup routes also answer 404 once the owner
// exists, and recovery answers 404 before it exists. Wrong tokens count per IP in the
// AuthRateLimiter Durable Object. The token is in the body, never in the URL.

export const SETUP_TOKEN_MIN_LENGTH = 32;
const OWNER_SETTING = "owner_user_id";
const PLATFORM_GUIDE = "docs/guides/cloudflare-platform.md";
const DATABASE_GUIDE = "docs/guides/database-d1.md";

type SetupAppEnv = { Bindings: Env };

export interface SetupRoutesOptions {
  limiter?: (env: Env) => AttemptLimiter;
  appOrigin?: (c: Context<SetupAppEnv>) => string;
}

export function setupTokenConfigured(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= SETUP_TOKEN_MIN_LENGTH;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Compares in constant time. Both sides are hashed first, so the comparison takes the
 * same time for every length and leaks nothing about the expected token.
 */
export async function setupTokenMatches(expected: string, provided: unknown): Promise<boolean> {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const [a, b] = await Promise.all([sha256(expected), sha256(provided)]);
  return timingSafeEqualBytes(a, b);
}

// Checks ------------------------------------------------------------------------------------

export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  /** How to fix a failed check. Null when the check passes. */
  hint: string | null;
}

/** Tables that the migrations create. A missing one means a migration did not run. */
export const REQUIRED_TABLES = [
  "users",
  "workspaces",
  "workspace_members",
  "system_settings",
  "api_keys",
  "audit_log",
  "idempotency_keys",
  // From migration 0003, so a deploy that skipped it is caught.
  "imports",
  "exports",
  AUTH_TABLES.user,
  AUTH_TABLES.session,
  AUTH_TABLES.account,
  AUTH_TABLES.verification,
  AUTH_TABLES.passkey,
] as const;

const MIGRATE_HINT =
  "Run `npx wrangler d1 migrations apply DB --remote` from the repository root. " +
  "The deploy script runs it, so a failed deploy can leave this step undone.";

function check(id: string, label: string, ok: boolean, hint: string): SetupCheck {
  return { id, label, ok, hint: ok ? null : hint };
}

/** Verifies the bindings, the secrets, and the migrations (KTD6). Never throws. */
export async function runSetupChecks(env: Env): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  const bindingHint = (name: string) =>
    `The ${name} binding is missing. Keep it in wrangler.jsonc and deploy again.`;

  let databaseOk = false;
  try {
    await env.DB.prepare("SELECT 1").first();
    databaseOk = true;
  } catch {
    databaseOk = false;
  }
  checks.push(
    check(
      "database",
      "D1 database",
      databaseOk,
      `${bindingHint("DB")} If it exists, check that the D1 database was created.`,
    ),
  );

  let missing: string[] = [...REQUIRED_TABLES];
  if (databaseOk) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all<{ name: string }>();
      const present = new Set(results.map((row) => row.name));
      missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    } catch {
      // Keep every table as missing.
    }
  }
  checks.push(
    check(
      "migrations",
      "Database migrations",
      databaseOk && missing.length === 0,
      `${MIGRATE_HINT} Missing tables: ${missing.join(", ")}.`,
    ),
  );

  checks.push(check("kv", "KV namespace", env.KV !== undefined, bindingHint("KV")));
  checks.push(check("bucket", "R2 bucket", env.BUCKET !== undefined, bindingHint("BUCKET")));
  checks.push(
    check("queue", "Send queue", env.SEND_QUEUE !== undefined, bindingHint("SEND_QUEUE")),
  );
  checks.push(
    check(
      "import_workflow",
      "Import workflow",
      env.IMPORT_WORKFLOW !== undefined,
      bindingHint("IMPORT_WORKFLOW (Workflow)"),
    ),
  );
  checks.push(
    check(
      "rate_limiter",
      "Login rate limiter",
      env.AUTH_RATE_LIMITER !== undefined,
      bindingHint("AUTH_RATE_LIMITER (Durable Object)"),
    ),
  );
  const keyHint = (name: string) =>
    `Set the ${name} secret to 32 random bytes in base64: run \`openssl rand -base64 32\`, ` +
    `then \`npx wrangler secret put ${name}\`.`;
  checks.push(
    check(
      "signing_key",
      "SIGNING_KEY secret",
      isUsableKey(env.SIGNING_KEY),
      keyHint("SIGNING_KEY"),
    ),
  );
  checks.push(
    check(
      "encryption_key",
      "ENCRYPTION_KEY secret",
      isUsableKey(env.ENCRYPTION_KEY),
      keyHint("ENCRYPTION_KEY"),
    ),
  );
  return checks;
}

// Plan limits (R3) ---------------------------------------------------------------------------

// The list lives in `@envelopen/core`, so the usage view (U11) shows the same limits.
export { PLAN_LIMITS, type PlanLimit };

function limitsSummary(settings: AuthSettings) {
  return {
    limits: PLAN_LIMITS,
    guides: { platform: PLATFORM_GUIDE, database: DATABASE_GUIDE },
    auth: {
      loginMode: settings.loginMode,
      pbkdf2Iterations: settings.iterations,
      pbkdf2MaxIterations: PBKDF2_MAX_ITERATIONS,
    },
  };
}

// Owner state ----------------------------------------------------------------------------------

/** The owner's user id, or null before setup. A missing table counts as "no owner". */
export async function readOwnerId(conn: DbConnection): Promise<string | null> {
  try {
    const row = await conn.db
      .selectFrom("system_settings")
      .select("value")
      .where("key", "=", OWNER_SETTING)
      .executeTakeFirst();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// Routes ----------------------------------------------------------------------------------------

function notFound(c: Context<SetupAppEnv>) {
  // The same body as an unknown API route, so a closed screen looks like no screen.
  return c.json(
    { error: { code: "not_found", message: "No API route matches this request." } },
    404,
  );
}

function fail(
  c: Context<SetupAppEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    status,
  );
}

const TokenBody = z.object({ token: z.string().max(1024) });
const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const OwnerBody = TokenBody.extend({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  name: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(100),
  password: Password.optional(),
});
const RecoverBody = TokenBody.extend({ password: Password.optional() });

type GuardResult =
  | { response: Response }
  | { body: Record<string, unknown>; conn: DbConnection; ownerId: string | null };

export function createSetupRoutes(options: SetupRoutesOptions = {}): Hono<SetupAppEnv> {
  const limiterFor = options.limiter ?? defaultLimiter;
  const appOrigin = options.appOrigin ?? ((c) => new URL(c.req.url).origin);
  const app = new Hono<SetupAppEnv>();

  /** The common steps: closed screen, origin, owner state, rate limit, token. */
  async function guard(c: Context<SetupAppEnv>, needsOwner: boolean): Promise<GuardResult> {
    const expected = c.env.SETUP_TOKEN;
    if (!setupTokenConfigured(expected)) return { response: notFound(c) };

    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== appOrigin(c)) {
      return {
        response: fail(c, 403, "cross_origin", "This request must come from the Envelopen app."),
      };
    }

    const conn = createDb(c.env);
    const ownerId = await readOwnerId(conn);
    if ((ownerId !== null) !== needsOwner) return { response: notFound(c) };

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== "object" || parsed === null) throw new Error("Not an object.");
      body = parsed as Record<string, unknown>;
    } catch {
      return { response: fail(c, 400, "invalid_input", "Send a JSON object.") };
    }

    const limiter = limiterFor(c.env);
    const ipKey = attemptKeys.ip("setup", clientIp(c.req.raw));
    const status = await limiter.check(ipKey, SETUP_RULE);
    if (!status.allowed) return { response: tooManyAttempts(status) };

    if (!(await setupTokenMatches(expected, body.token))) {
      await limiter.record(ipKey, SETUP_RULE);
      return { response: fail(c, 401, "invalid_setup_token", "The setup token is not correct.") };
    }
    return { body, conn, ownerId };
  }

  app.post("/check", async (c) => {
    const result = await guard(c, false);
    if ("response" in result) return result.response;
    const checks = await runSetupChecks(c.env);
    return c.json({
      ready: checks.every((item) => item.ok),
      checks,
      ...limitsSummary(authSettings(c.env)),
    });
  });

  app.post("/owner", async (c) => {
    const result = await guard(c, false);
    if ("response" in result) return result.response;
    const { conn } = result;

    const parsed = OwnerBody.safeParse(result.body);
    if (!parsed.success) {
      return fail(c, 400, "invalid_input", "The input is not valid.", parsed.error.issues);
    }
    const input = parsed.data;
    const settings = authSettings(c.env);
    if (settings.loginMode === "password" && input.password === undefined) {
      return fail(
        c,
        400,
        "invalid_input",
        `Choose a password of ${PASSWORD_MIN_LENGTH} or more characters.`,
      );
    }

    const checks = await runSetupChecks(c.env);
    if (!checks.every((item) => item.ok)) {
      return fail(c, 409, "setup_checks_failed", "Fix the failed checks first.", checks);
    }

    const auth = await createAuth({ env: c.env, origin: appOrigin(c), d1: conn.d1 });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      { email: input.email, name: input.name, emailVerified: true },
      { method: settings.loginMode === "password" ? "email-password" : "setup-token" },
    );

    try {
      if (settings.loginMode === "password" && input.password !== undefined) {
        await context.internalAdapter.linkAccount({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await context.password.hash(input.password),
        });
      }

      // One batch: the app user, the first workspace, the owner membership, the owner
      // marker, and the audit row. The marker's primary key makes a second, concurrent
      // setup fail as a whole. The workspace id is chosen here, because a fresh install
      // has no workspaces and the batch fails on any id conflict.
      const next = await conn.db
        .selectFrom("workspaces")
        .select((eb) => eb.fn.max("id").as("max"))
        .executeTakeFirst();
      const workspaceId = Number(next?.max ?? 0) + 1;
      await conn.atomic([
        conn.db.insertInto("users").values({ id: user.id, email: input.email, name: input.name }),
        conn.db.insertInto("workspaces").values({ id: workspaceId, name: input.workspaceName }),
        conn.db
          .insertInto("workspace_members")
          .values({ workspace_id: workspaceId, user_id: user.id, role: "owner" }),
        conn.db.insertInto("system_settings").values({ key: OWNER_SETTING, value: user.id }),
        conn.db.insertInto("audit_log").values({
          workspace_id: workspaceId,
          actor_type: "user",
          actor_id: user.id,
          surface: "ui",
          api_key_id: null,
          action: "setup.owner_created",
          target_type: "workspace",
          target_id: String(workspaceId),
          metadata: JSON.stringify({ loginMode: settings.loginMode }),
          ip: c.req.header("cf-connecting-ip") ?? null,
        }),
      ]);

      const passkeyEnrollment =
        settings.loginMode === "passkey"
          ? await createPasskeyEnrollment(context, user.id, "setup")
          : null;
      return c.json(
        { userId: user.id, workspaceId, loginMode: settings.loginMode, passkeyEnrollment },
        201,
      );
    } catch (error) {
      // Undo the Better Auth user (its accounts cascade), so setup can run again.
      await context.adapter
        .delete({ model: "user", where: [{ field: "id", value: user.id }] })
        .catch(() => undefined);
      if ((await readOwnerId(conn)) !== null) return notFound(c);
      throw error;
    }
  });

  app.post("/recover", async (c) => {
    const result = await guard(c, true);
    if ("response" in result) return result.response;
    const { conn } = result;
    const ownerId = result.ownerId as string;

    const parsed = RecoverBody.safeParse(result.body);
    if (!parsed.success) {
      return fail(c, 400, "invalid_input", "The input is not valid.", parsed.error.issues);
    }
    const settings = authSettings(c.env);
    const auth = await createAuth({ env: c.env, origin: appOrigin(c), d1: conn.d1 });
    const context = await auth.$context;
    const owner = await context.internalAdapter.findUserById(ownerId);
    if (!owner) return notFound(c);

    const audit = (action: string) =>
      conn.db
        .insertInto("audit_log")
        .values({
          workspace_id: null,
          actor_type: "system",
          actor_id: "setup_token",
          surface: "ui",
          api_key_id: null,
          action,
          target_type: "user",
          target_id: ownerId,
          metadata: null,
          ip: c.req.header("cf-connecting-ip") ?? null,
        })
        .execute();

    if (settings.loginMode === "passkey") {
      // The new passkey replaces the old ones when the owner registers it (passkeys.ts).
      const passkeyEnrollment = await createPasskeyEnrollment(context, ownerId, "recovery");
      await audit("setup.passkey_recovery_started");
      return c.json({ loginMode: settings.loginMode, passkeyEnrollment });
    }

    const password = parsed.data.password;
    if (password === undefined) {
      return fail(
        c,
        400,
        "invalid_input",
        `Choose a password of ${PASSWORD_MIN_LENGTH} or more characters.`,
      );
    }
    const hash = await context.password.hash(password);
    const account = await context.internalAdapter.findCredentialAccount(ownerId);
    if (account) {
      await context.internalAdapter.updatePassword(ownerId, hash);
    } else {
      await context.internalAdapter.linkAccount({
        userId: ownerId,
        providerId: "credential",
        accountId: ownerId,
        password: hash,
      });
    }
    // A reset ends every session, and the owner's email may log in again at once.
    await context.internalAdapter.deleteUserSessions(ownerId);
    await limiterFor(c.env).reset(await attemptKeys.email("login", owner.email));
    await audit("setup.password_reset");
    return c.json({ loginMode: settings.loginMode, passkeyEnrollment: null });
  });

  app.all("*", (c) => notFound(c));
  return app;
}
