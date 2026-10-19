import { type Principal, resolveApiKey } from "@envelopen/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiEnv } from "./context";
import { errorJson } from "./errors";

/**
 * Resolves a browser session to a Principal, or returns null when there is no valid
 * session. U4 provides the Better Auth implementation. A session principal must have
 * `actorType: "user"` and `surface: "ui"`.
 */
export type SessionResolver = (c: Context<ApiEnv>) => Promise<Principal | null>;

/** The resolver until U4 adds sessions: no request has a session. */
export const noSessionResolver: SessionResolver = async () => null;

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Resolves the Principal for every `/api` request and stores it in the context.
 * An `Authorization` header always means an API key: an invalid key gets 401 and
 * the request never falls back to the session cookie. Without the header, the
 * session resolver runs. This middleware checks identity only. The service layer
 * checks scopes.
 */
export function principalMiddleware(resolveSession: SessionResolver): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    let principal: Principal | null;
    if (authorization !== undefined) {
      const token = BEARER.exec(authorization)?.[1];
      principal = token ? await resolveApiKey(c.var.db, token, { surface: "rest" }) : null;
    } else {
      principal = await resolveSession(c);
    }
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="envelopen"');
      return errorJson(c, 401, "unauthenticated", "Sign in, or send a valid API key.");
    }
    c.set("principal", principal);
    await next();
  };
}
