import { ALL_SCOPES, type ApiKeyScope, type Scope } from "./scopes";

export type ActorType = "user" | "api_key";

/** The transport that the request came through. */
export type PrincipalSurface = "ui" | "rest" | "mcp";

/**
 * Who makes a request (KTD10). A UI session and an API key both resolve to this type.
 * Transports resolve it and pass it to the service layer, which checks the scopes and
 * writes the audit log. Transports never check scopes themselves.
 */
export interface Principal {
  readonly workspaceId: number;
  readonly actorType: ActorType;
  /** The user id for a session, or the API key id as a string. */
  readonly actorId: string;
  /** The API key id, or null for a session. */
  readonly apiKeyId: number | null;
  readonly scopes: ReadonlySet<Scope>;
  readonly surface: PrincipalSurface;
  /**
   * For a session: when the sign-in that created the session completed, in Unix
   * milliseconds. Sensitive actions need a recent sign-in (requireRecentSignIn).
   */
  readonly signedInAt?: number | null;
}

/** The owner's session. In v1 the owner has every scope. */
export function sessionPrincipal(input: {
  workspaceId: number;
  userId: string;
  signedInAt?: number | null;
}): Principal {
  return {
    workspaceId: input.workspaceId,
    actorType: "user",
    actorId: input.userId,
    apiKeyId: null,
    scopes: new Set<Scope>(ALL_SCOPES),
    surface: "ui",
    signedInAt: input.signedInAt ?? null,
  };
}

/**
 * A sensitive action needs a sign-in that completed this recently. It is the same rule
 * as for adding a passkey (apps/worker/src/auth/passkeys.ts).
 */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;
/** The error detail code that tells the admin app to ask the owner to sign in again. */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

/** True for a session whose sign-in completed within RECENT_SIGN_IN_MS of `now`. */
export function hasRecentSignIn(principal: Principal, now: number): boolean {
  if (principal.actorType !== "user") return false;
  const at = principal.signedInAt;
  return typeof at === "number" && now - at < RECENT_SIGN_IN_MS && at <= now + 60_000;
}

export function apiKeyPrincipal(input: {
  workspaceId: number;
  apiKeyId: number;
  scopes: Iterable<ApiKeyScope>;
  surface: Exclude<PrincipalSurface, "ui">;
}): Principal {
  return {
    workspaceId: input.workspaceId,
    actorType: "api_key",
    actorId: String(input.apiKeyId),
    apiKeyId: input.apiKeyId,
    scopes: new Set<Scope>(input.scopes),
    surface: input.surface,
  };
}

/** A stable identifier for the actor, for example `api_key:3` or `user:abc`. */
export function principalKey(principal: Principal): string {
  return `${principal.actorType}:${principal.actorId}`;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}
