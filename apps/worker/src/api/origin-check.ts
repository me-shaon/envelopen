import type { Context, MiddlewareHandler } from "hono";
import type { ApiEnv } from "./context";
import { errorJson } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The app origin. By default it is the origin of the request URL, because one Worker serves the app and the API. */
export type AppOriginResolver = (c: Context<ApiEnv>) => string;

export const requestOrigin: AppOriginResolver = (c) => new URL(c.req.url).origin;

/**
 * KTD8 and R74: a state-changing request with a session principal must carry an
 * `Origin` header that matches the app origin. A missing `Origin` fails too. API-key
 * requests skip the check, because a browser never attaches a key on its own.
 * Run it after the principal middleware.
 */
export function originCheck(
  appOrigin: AppOriginResolver = requestOrigin,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const principal = c.var.principal;
    if (principal.actorType === "user" && !SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin === undefined || origin !== appOrigin(c)) {
        return errorJson(c, 403, "cross_origin", "This request must come from the Envelopen app.");
      }
    }
    await next();
  };
}
