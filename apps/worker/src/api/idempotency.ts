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

/** Who used a key, and where. A key is unique per workspace, principal, method, and route. */
export interface IdempotencyIdentity {
  workspaceId: number;
  /** `principalKey()` of the caller. */
  principalId: string;
  /** The HTTP method, or `MCP` for a tool call. */
  method: string;
  /** The registry path, or the operation id for a tool call. */
  route: string;
  key: string;
}

/** The outcome of claiming a key. */
export type IdempotencyClaim =
  /** First use: run the operation, then call `complete` on success or `release` on failure. */
  | {
      kind: "new";
      complete(status: number, body: string): Promise<void>;
      release(): Promise<void>;
    }
  /** The stored response of the first successful use. */
  | { kind: "replay"; status: number; body: string }
  | { kind: "reused"; message: string }
  | { kind: "in_progress"; message: string };

const REUSED_MESSAGE = "This Idempotency-Key was used with a different request body.";
const IN_PROGRESS_MESSAGE = "A request with this Idempotency-Key is still running.";

export function isIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export async function hashIdempotentRequest(body: string): Promise<string> {
  return sha256Hex(body);
}

/**
 * Claims an idempotency key for one request. The REST middleware and the MCP tools both
 * use it, so retries behave the same on every surface (R58). A stored response is kept
 * for 24 hours. An expired key starts over.
 */
export async function claimIdempotencyKey(
  conn: DbConnection,
  identity: IdempotencyIdentity,
  requestHash: string,
  now = Date.now(),
): Promise<IdempotencyClaim> {
  const { db } = conn;
  const { workspaceId } = identity;
  const values = {
    workspace_id: workspaceId,
    principal_id: identity.principalId,
    method: identity.method,
    route: identity.route,
    key: identity.key,
  };

  const reserve = () =>
    db
      .insertInto("idempotency_keys")
      .values({ ...values, request_hash: requestHash, expires_at: now + IDEMPOTENCY_TTL_MS })
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
      .where("workspace_id", "=", workspaceId)
      .where("principal_id", "=", values.principal_id)
      .where("method", "=", values.method)
      .where("route", "=", values.route)
      .where("key", "=", values.key)
      .executeTakeFirst();

    if (existing && existing.expires_at <= now) {
      await db
        .deleteFrom("idempotency_keys")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", existing.id)
        .execute();
      reserved = await reserve();
    } else if (existing) {
      if (existing.request_hash !== requestHash) return { kind: "reused", message: REUSED_MESSAGE };
      if (existing.response_status === null) {
        return { kind: "in_progress", message: IN_PROGRESS_MESSAGE };
      }
      return {
        kind: "replay",
        status: existing.response_status,
        body: existing.response_body ?? "",
      };
    }
    if (!reserved) return { kind: "in_progress", message: IN_PROGRESS_MESSAGE };
  }

  const id = reserved.id;
  return {
    kind: "new",
    async complete(status, body) {
      await db
        .updateTable("idempotency_keys")
        .set({ response_status: status, response_body: body })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .execute();
    },
    async release() {
      await db
        .deleteFrom("idempotency_keys")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .execute();
    },
  };
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
    if (!isIdempotencyKey(key)) {
      return errorJson(
        c,
        400,
        "idempotency_key_invalid",
        "The Idempotency-Key header must be 1 to 255 visible ASCII characters.",
      );
    }

    const claim = await claimIdempotencyKey(
      c.var.db,
      {
        workspaceId: c.var.principal.workspaceId,
        principalId: principalKey(c.var.principal),
        method: c.req.method,
        route,
        key,
      },
      await sha256Hex(await c.req.text()),
    );
    if (claim.kind === "reused") {
      return errorJson(c, 422, "idempotency_key_reused", claim.message);
    }
    if (claim.kind === "in_progress") {
      return errorJson(c, 409, "idempotency_in_progress", claim.message);
    }
    if (claim.kind === "replay") {
      return new Response(claim.body, {
        status: claim.status,
        headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
      });
    }

    try {
      await next();
    } catch (error) {
      await claim.release();
      throw error;
    }

    // Hono's compose catches handler errors and sets an error response, so check c.error too.
    const status = c.res.status;
    if (c.error || status < 200 || status >= 300) {
      await claim.release();
      return;
    }
    await claim.complete(status, await c.res.clone().text());
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
