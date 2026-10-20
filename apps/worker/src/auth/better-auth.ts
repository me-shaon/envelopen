import { betterAuth } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { createPasskeyPlugin, type LoginMode, loginModeFor, requireFreshSession } from "./passkeys";
import { createPasswordHasher, needsRehash, resolveIterations } from "./pbkdf2-hasher";
import { authSchemaOptions } from "./schema-options";

// Better Auth (KTD7, KTD8). The Worker creates one instance per request, because the
// instance holds the request's database binding and the app origin.

export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_COOKIE_PREFIX = "envelopen";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** The bindings and variables that auth reads. */
export interface AuthEnv {
  SIGNING_KEY?: string | undefined;
  PBKDF2_ITERATIONS?: string | undefined;
}

export interface AuthSettings {
  iterations: number;
  loginMode: LoginMode;
}

export function authSettings(env: Pick<AuthEnv, "PBKDF2_ITERATIONS">): AuthSettings {
  const iterations = resolveIterations(env.PBKDF2_ITERATIONS);
  return { iterations, loginMode: loginModeFor(iterations) };
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** True when the value is base64 for at least 32 bytes, as `openssl rand -base64 32` makes. */
export function isUsableKey(value: string | undefined): value is string {
  return value !== undefined && (decodeBase64(value)?.length ?? 0) >= 32;
}

/**
 * The Better Auth secret, derived from SIGNING_KEY with HKDF. A separate derivation
 * keeps the cookie-signing key apart from the tracking-token keys, and the owner
 * manages one secret fewer.
 */
export async function deriveAuthSecret(signingKey: string | undefined): Promise<string> {
  const keyBytes = isUsableKey(signingKey) ? decodeBase64(signingKey) : null;
  if (!keyBytes) {
    throw new Error("SIGNING_KEY is missing or shorter than 32 bytes of base64.");
  }
  const material = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("envelopen/better-auth/v1"),
    },
    material,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CreateAuthOptions {
  env: AuthEnv;
  /** The app origin, for example `https://envelopen.example.com`. No trailing slash. */
  origin: string;
  /** The metered D1 binding from `createDb()`, so auth writes count toward the meter (KTD24). */
  d1: D1Database;
}

export async function createAuth({ env, origin, d1 }: CreateAuthOptions) {
  const { iterations } = authSettings(env);
  const hasher = createPasswordHasher(iterations);

  return betterAuth({
    appName: "Envelopen",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: await deriveAuthSecret(env.SIGNING_KEY),
    // The metered binding has `prepare`, `batch`, and `exec`, so Better Auth's Kysely
    // adapter detects it as D1 and uses its D1 dialect.
    database: d1,
    ...authSchemaOptions,
    // KTD8: exactly one trusted origin, the app itself.
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      // The first-run screen creates the owner. Nobody signs up.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      password: hasher,
      revokeSessionsOnPasswordReset: true,
    },
    // routes.ts limits login with the AuthRateLimiter Durable Object (KTD8). The
    // built-in limiter keeps its counts in isolate memory, so it is off.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // The committed migration defines the schema. Validation would introspect the
      // database on every new instance, which is every request here.
      database: { validateSchema: false },
    },
    hooks: {
      // A signed-in owner adds a passkey only from a fresh session (passkeys.ts). Check
      // it before the browser prompt too, so the owner does not touch the authenticator
      // for nothing. A request with an enrollment token is checked by resolveUser.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/passkey/generate-register-options") return;
        if ((ctx.query as { context?: unknown } | undefined)?.context) return;
        if (!(await getSessionFromCtx(ctx))) return;
        await requireFreshSession(ctx);
      }),
      // Rehash a password that uses old parameters, at the login that proves it (KTD7).
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const userId = ctx.context.newSession?.user.id;
        const password = (ctx.body as { password?: unknown } | undefined)?.password;
        if (!userId || typeof password !== "string") return;
        const account = await ctx.context.internalAdapter.findCredentialAccount(userId);
        if (account?.password && needsRehash(account.password, iterations)) {
          await ctx.context.internalAdapter.updatePassword(userId, await hasher.hash(password));
        }
      }),
    },
    plugins: [createPasskeyPlugin(origin)],
  });
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
