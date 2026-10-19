import { type DbConnection, unscoped } from "@envelopen/db";
import { apiKeyPrincipal, type Principal } from "./principal";
import { type ApiKeyScope, isApiKeyScope } from "./scopes";

// API key format: "evk_" and 43 base64url characters (32 random bytes). The database
// stores the SHA-256 hash of the full key, and a public prefix that the UI shows.
// The key itself is shown once at creation (U4) and never stored.

export const API_KEY_PREFIX = "evk_";
/** Characters of the key that the `prefix` column keeps: "evk_" and 8 more. */
export const API_KEY_DISPLAY_LENGTH = 12;
const API_KEY_PATTERN = /^evk_[A-Za-z0-9_-]{43}$/;

/** `last_used_at` is updated at most once per this interval, to save D1 writes. */
const LAST_USED_INTERVAL_MS = 60 * 60 * 1000;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isApiKeyFormat(token: string): boolean {
  return API_KEY_PATTERN.test(token);
}

/** Hex SHA-256 of the full key. */
export async function hashApiKey(key: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
}

export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_LENGTH);
}

export interface GeneratedApiKey {
  /** Show this to the owner once. Never store it. */
  key: string;
  prefix: string;
  keyHash: string;
}

/** Makes a new random key with its prefix and hash. U4 stores the prefix and hash. */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  const key = API_KEY_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { key, prefix: apiKeyDisplayPrefix(key), keyHash: await hashApiKey(key) };
}

/** Parses the JSON scopes column. Unknown scopes and session-only scopes are dropped. */
export function parseKeyScopes(json: string): ApiKeyScope[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter(isApiKeyScope) : [];
}

/**
 * Resolves a bearer token to a Principal, or returns null when the key is unknown,
 * revoked, expired, or belongs to an archived workspace. The lookup uses the
 * prefix and the hash, so the key itself never reaches the database.
 */
export async function resolveApiKey(
  conn: DbConnection,
  token: string,
  options: { surface: "rest" | "mcp"; now?: number },
): Promise<Principal | null> {
  if (!isApiKeyFormat(token)) return null;
  const now = options.now ?? Date.now();
  const keyHash = await hashApiKey(token);

  // The workspace is not known yet, so this lookup is deliberately unscoped (KTD4).
  const row = await unscoped(conn.db)
    .selectFrom("api_keys")
    .innerJoin("workspaces", "workspaces.id", "api_keys.workspace_id")
    .select([
      "api_keys.id",
      "api_keys.workspace_id",
      "api_keys.scopes",
      "api_keys.last_used_at",
      "api_keys.expires_at",
      "api_keys.revoked_at",
    ])
    .where("api_keys.prefix", "=", apiKeyDisplayPrefix(token))
    .where("api_keys.key_hash", "=", keyHash)
    .where("workspaces.archived_at", "is", null)
    .executeTakeFirst();

  if (!row || row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_INTERVAL_MS) {
    try {
      await conn.db
        .updateTable("api_keys")
        .set({ last_used_at: now })
        .where("workspace_id", "=", row.workspace_id)
        .where("id", "=", row.id)
        .execute();
    } catch {
      // A failed bookkeeping write, for example after the D1 daily limit on Free,
      // must not block the request.
    }
  }

  return apiKeyPrincipal({
    workspaceId: row.workspace_id,
    apiKeyId: row.id,
    scopes: parseKeyScopes(row.scopes),
    surface: options.surface,
  });
}
