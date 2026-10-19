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
}

/** The owner's session. In v1 the owner has every scope. */
export function sessionPrincipal(input: { workspaceId: number; userId: string }): Principal {
  return {
    workspaceId: input.workspaceId,
    actorType: "user",
    actorId: input.userId,
    apiKeyId: null,
    scopes: new Set<Scope>(ALL_SCOPES),
    surface: "ui",
  };
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
