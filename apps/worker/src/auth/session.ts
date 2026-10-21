import { resolveSessionPrincipal, WORKSPACE_HEADER } from "@envelopen/core";
import type { SessionResolver } from "../api/auth";
import { type AppOriginResolver, requestOrigin } from "../api/origin-check";
import { createAuth } from "./better-auth";

/**
 * Turns a Better Auth session cookie into a session Principal (KTD10). The workspace
 * comes from the `X-Envelopen-Workspace` header, or is the user's oldest active
 * workspace. The owner gets every scope, `workspace:admin` included.
 *
 * Better Auth may refresh the session on this request. Its `Set-Cookie` headers are
 * copied to the response, so the session keeps sliding.
 */
export function betterAuthSessionResolver(
  appOrigin: AppOriginResolver = requestOrigin,
): SessionResolver {
  return async (c) => {
    // No cookie, no session. This skips the auth setup for cookieless requests.
    if (!c.req.header("cookie")) return null;
    const auth = await createAuth({ env: c.env, origin: appOrigin(c), d1: c.var.db.d1 });
    const { headers, response } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    if (!response) return null;
    // The session row is created at sign-in, so its creation time is the sign-in time.
    const signedInAt = new Date(response.session.createdAt).getTime();
    return resolveSessionPrincipal(
      c.var.db,
      response.user.id,
      c.req.header(WORKSPACE_HEADER),
      Number.isFinite(signedInAt) ? signedInAt : null,
    );
  };
}
