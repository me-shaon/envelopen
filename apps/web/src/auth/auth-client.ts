import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";

// Calls to the auth and setup routes of the Worker. They are not registry operations,
// so they are not in the OpenAPI client. Better Auth serves /api/auth/*, and
// apps/worker/src/setup/first-run.ts serves /api/setup/*.

export type LoginMode = "password" | "passkey";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  user: SessionUser;
}

/** A failed auth or setup call, with a message for the person. */
export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    // Better Auth answers { code, message }. The setup routes answer { error: {...} }.
    const raw = (body ?? {}) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string; details?: unknown };
    };
    const error = raw.error ?? raw;
    throw new AuthRequestError(
      response.status,
      error.code ?? "unknown",
      error.message ?? "The request failed. Try again.",
      raw.error?.details,
    );
  }
  return body as T;
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

// Sessions and login -------------------------------------------------------------------

export async function getSession(): Promise<Session | null> {
  const result = await request<{ user?: SessionUser } | null>("/api/auth/get-session");
  return result?.user ? { user: result.user } : null;
}

export async function getLoginMode(): Promise<LoginMode> {
  const result = await request<{ loginMode: LoginMode }>("/api/auth/mode");
  return result.loginMode;
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  await post("/api/auth/sign-in/email", { email, password });
}

export async function signOut(): Promise<void> {
  await post("/api/auth/sign-out");
}

function ceremonyError(error: unknown, fallback: string): AuthRequestError {
  if (error instanceof AuthRequestError) return error;
  if (error instanceof WebAuthnError && error.code === "ERROR_CEREMONY_ABORTED") {
    return new AuthRequestError(400, error.code, "The passkey prompt was closed. Try again.");
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return new AuthRequestError(400, "not_allowed", "The passkey prompt was closed. Try again.");
  }
  return new AuthRequestError(400, "passkey_failed", fallback);
}

export async function signInWithPasskey(): Promise<void> {
  try {
    const options = await request<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const { clientExtensionResults: _ignored, ...response } = await startAuthentication({
      optionsJSON: options,
    });
    await post("/api/auth/passkey/verify-authentication", { response });
  } catch (error) {
    throw ceremonyError(error, "The passkey did not work. Try again.");
  }
}

/**
 * Registers a passkey with an enrollment token from setup or recovery, and signs in.
 * The token is the `context` of the WebAuthn registration (apps/worker/src/auth/passkeys.ts).
 */
export async function registerPasskey(enrollmentToken: string): Promise<void> {
  try {
    const query = new URLSearchParams({ context: enrollmentToken });
    const options = await request<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      `/api/auth/passkey/generate-register-options?${query}`,
    );
    const { clientExtensionResults: _ignored, ...response } = await startRegistration({
      optionsJSON: options,
    });
    await post("/api/auth/passkey/verify-registration", { response, createSession: true });
  } catch (error) {
    throw ceremonyError(error, "The passkey was not saved. Try again.");
  }
}

// First-run setup and recovery (KTD6) ---------------------------------------------------------

export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  hint: string | null;
}

export interface PlanLimit {
  id: string;
  label: string;
  free: string;
  paid: string;
}

export interface SetupCheckResult {
  ready: boolean;
  checks: SetupCheck[];
  limits: PlanLimit[];
  guides: { platform: string; database: string };
  auth: { loginMode: LoginMode; pbkdf2Iterations: number; pbkdf2MaxIterations: number };
}

export interface PasskeyEnrollment {
  token: string;
  expiresAt: number;
}

export interface OwnerInput {
  token: string;
  email: string;
  name: string;
  workspaceName: string;
  password?: string;
}

export function setupCheck(token: string): Promise<SetupCheckResult> {
  return post("/api/setup/check", { token });
}

export function setupOwner(input: OwnerInput): Promise<{
  userId: string;
  workspaceId: number;
  loginMode: LoginMode;
  passkeyEnrollment: PasskeyEnrollment | null;
}> {
  return post("/api/setup/owner", input);
}

export function setupRecover(
  token: string,
  password?: string,
): Promise<{ loginMode: LoginMode; passkeyEnrollment: PasskeyEnrollment | null }> {
  return post("/api/setup/recover", password === undefined ? { token } : { token, password });
}

/** Password rules of the Worker (apps/worker/src/auth/better-auth.ts). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
