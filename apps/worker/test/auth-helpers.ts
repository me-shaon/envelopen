import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { attemptKeys } from "../src/auth/rate-limit-do";
import worker from "../src/index";

// Helpers for the auth and first-run tests. They call the real Worker entry, so the
// requests go through the same routes, Better Auth instance, and Durable Object as
// production.

export const APP_ORIGIN = "https://envelopen.test";
export const SETUP_TOKEN = "0123456789abcdef0123456789abcdef0123456789";
export const OWNER = {
  email: "owner@example.com",
  name: "Owner",
  workspaceName: "Main",
  password: "a-long-owner-password",
};

function base64Key(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const SIGNING_KEY = base64Key();
const ENCRYPTION_KEY = base64Key();

// PBKDF2_ITERATIONS is typed as the literal from wrangler.jsonc. Tests try other counts.
type EnvOverrides = {
  [K in Exclude<keyof Env, "PBKDF2_ITERATIONS">]?: Env[K] | undefined;
} & { PBKDF2_ITERATIONS?: string };

/** The test bindings with the secrets set. Pass `undefined` to remove one. */
export function testEnv(overrides: EnvOverrides = {}): Env {
  const merged: Record<string, unknown> = {
    ...(env as unknown as Record<string, unknown>),
    SETUP_TOKEN,
    SIGNING_KEY,
    ENCRYPTION_KEY,
    PBKDF2_ITERATIONS: "100000",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as Env;
}

let ipCounter = 0;
/** A fresh client IP, so the login and setup counters of other tests do not apply. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(Math.random() * 200)}.${ipCounter % 250}`;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  env?: Env;
  ip?: string;
  /** Defaults to the app origin for non-GET requests. Pass null to omit it. */
  origin?: string | null;
}

export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    "cf-connecting-ip": options.ip ?? "192.0.2.1",
    ...options.headers,
  };
  const origin = options.origin === undefined && method !== "GET" ? APP_ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return worker.fetch(request, options.env ?? testEnv(), createExecutionContext());
}

/** The `Cookie` header that a browser would send after this response. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] as string)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/**
 * Removes the owner and every auth row, so each test starts at the first-run screen.
 * Also clears the owner email's login counters. IP counters need no reset: every test
 * uses fresh IPs.
 */
export async function resetAuthState(): Promise<void> {
  for (const action of ["login", "login-ceiling"]) {
    await env.AUTH_RATE_LIMITER.getByName(await attemptKeys.email(action, OWNER.email)).reset();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM system_settings WHERE key = 'owner_user_id'"),
    env.DB.prepare("DELETE FROM auth_verification"),
    env.DB.prepare("DELETE FROM auth_user"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

export interface CreatedOwner {
  userId: string;
  workspaceId: number;
  loginMode: "password" | "passkey";
  passkeyEnrollment: { token: string; expiresAt: number } | null;
}

export async function createOwner(
  options: { env?: Env; password?: string | null } = {},
): Promise<CreatedOwner> {
  const password = options.password === undefined ? OWNER.password : options.password;
  const res = await call("/api/setup/owner", {
    env: options.env,
    ip: freshIp(),
    body: {
      token: SETUP_TOKEN,
      email: OWNER.email,
      name: OWNER.name,
      workspaceName: OWNER.workspaceName,
      ...(password === null ? {} : { password }),
    },
  });
  if (res.status !== 201) throw new Error(`Setup failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as CreatedOwner;
}

export function signIn(password: string, options: { ip?: string; env?: Env } = {}) {
  return call("/api/auth/sign-in/email", {
    env: options.env,
    ip: options.ip ?? freshIp(),
    body: { email: OWNER.email, password },
  });
}

/** Signs the owner in and returns the session cookie header. */
export async function ownerSession(env?: Env): Promise<string> {
  const res = await signIn(OWNER.password, { env });
  if (res.status !== 200) throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  return cookiesFrom(res);
}
