import { principalKey } from "@envelopen/core";
import { type DbConnection, unscoped } from "@envelopen/db";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./context";
import { errorJson } from "./errors";

// Idempotency keys for POST requests (R58). The first response is stored per
// workspace, principal, method, route, and key for 24 hours. A retry with the same
// key and the same body gets the stored response, and the operation does not run again.

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Route middleware for one POST operation. `route` is the registry path, so
 * `/contacts/{id}` shares nothing with other routes. Run it after the principal middleware.
 *
 * - A stored 2xx response is replayed with the `Idempotent-Replayed: true` header.
 * - The same key with a different body gets 422.
 * - The same key while the first request still runs gets 409.
 * - A response that is not 2xx is not stored, so the client can fix the problem and retry.
 */
export function idempotency(route: string): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      return errorJson(
        c,
        400,
        "idempotency_key_invalid",
        "The Idempotency-Key header must be 1 to 255 visible ASCII characters.",
      );
    }

    const { db } = c.var.db;
    const workspaceId = c.var.principal.workspaceId;
    const identity = {
      workspace_id: workspaceId,
      principal_id: principalKey(c.var.principal),
      method: c.req.method,
      route,
      key,
    };
    const requestHash = await sha256Hex(await c.req.text());
    const now = Date.now();

    const reserve = () =>
      db
        .insertInto("idempotency_keys")
        .values({ ...identity, request_hash: requestHash, expires_at: now + IDEMPOTENCY_TTL_MS })
        .onConflict((conflict) =>
          conflict.columns(["workspace_id", "principal_id", "method", "route", "key"]).doNothing(),
        )
        .returning("id")
        .executeTakeFirst();

    let reserved = await reserve();
    if (!reserved) {
      const existing = await db
        .selectFrom("idempotency_keys")
        .select(["id", "request_hash", "response_status", "response_body", "expires_at"])
        .where("workspace_id", "=", identity.workspace_id)
        .where("principal_id", "=", identity.principal_id)
        .where("method", "=", identity.method)
        .where("route", "=", identity.route)
        .where("key", "=", identity.key)
        .executeTakeFirst();

      if (existing && existing.expires_at <= now) {
        // An expired key starts over.
        await db
          .deleteFrom("idempotency_keys")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", existing.id)
          .execute();
        reserved = await reserve();
      } else if (existing) {
        if (existing.request_hash !== requestHash) {
          return errorJson(
            c,
            422,
            "idempotency_key_reused",
            "This Idempotency-Key was used with a different request body.",
          );
        }
        if (existing.response_status === null) {
          return errorJson(
            c,
            409,
            "idempotency_in_progress",
            "A request with this Idempotency-Key is still running.",
          );
        }
        return new Response(existing.response_body, {
          status: existing.response_status,
          headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
        });
      }
      if (!reserved) {
        return errorJson(
          c,
          409,
          "idempotency_in_progress",
          "A request with this Idempotency-Key is still running.",
        );
      }
    }

    const id = reserved.id;
    const release = () =>
      db
        .deleteFrom("idempotency_keys")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .execute();

    try {
      await next();
    } catch (error) {
      await release();
      throw error;
    }

    // Hono's compose catches handler errors and sets an error response, so check c.error too.
    const status = c.res.status;
    if (c.error || status < 200 || status >= 300) {
      await release();
      return;
    }
    await db
      .updateTable("idempotency_keys")
      .set({ response_status: status, response_body: await c.res.clone().text() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .execute();
  };
}

/** Deletes expired idempotency keys in every workspace. The cron runs it. */
export async function purgeExpiredIdempotencyKeys(
  conn: DbConnection,
  now = Date.now(),
): Promise<void> {
  // A cross-workspace cleanup, so it is deliberately unscoped (KTD4).
  await unscoped(conn.db).deleteFrom("idempotency_keys").where("expires_at", "<=", now).execute();
}
