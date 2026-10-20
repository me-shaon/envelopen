import type { MiddlewareHandler } from "hono";

/**
 * Sets `Cache-Control: no-store` on API responses that set no cache policy of their own.
 * API responses hold workspace data, and a session or an API key authorized them, so no
 * browser or proxy cache may keep them. Routes such as the signed file downloads keep the
 * header that they set.
 */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
};
