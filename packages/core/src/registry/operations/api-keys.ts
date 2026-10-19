import { z } from "zod";
import { generateApiKey, parseKeyScopes } from "../../api-keys";
import { OperationError } from "../../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../../pagination";
import {
  API_KEY_PRESETS,
  API_KEY_SCOPES,
  type ApiKeyScope,
  SCOPE_DESCRIPTIONS,
} from "../../scopes";
import { defineOperation } from "../operation";

// API key management (R7). Owner session only: workspace:admin, never through MCP.
// The database stores the key's SHA-256 hash and a display prefix. The key itself is
// in the create response only.

const API_KEY_MCP = {
  class: "never",
  reason: "API keys are managed by the owner. No key can create, list, or revoke keys.",
} as const;

const PRESET_IDS = Object.keys(API_KEY_PRESETS) as [
  keyof typeof API_KEY_PRESETS,
  ...(keyof typeof API_KEY_PRESETS)[],
];

export const ApiKeySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    prefix: z.string().meta({ description: "The start of the key, to recognize it." }),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    createdAt: z.number().int().meta({ description: "Unix milliseconds." }),
    lastUsedAt: z.number().int().nullable().meta({ description: "Unix milliseconds, hourly." }),
    expiresAt: z.number().int().nullable().meta({ description: "Unix milliseconds." }),
    revokedAt: z.number().int().nullable().meta({ description: "Unix milliseconds." }),
  })
  .meta({ id: "ApiKey" });

export const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string().meta({ description: "The full key. It is shown once and never again." }),
}).meta({ id: "CreatedApiKey" });

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

const API_KEY_COLUMNS = [
  "id",
  "name",
  "prefix",
  "scopes",
  "created_at",
  "last_used_at",
  "expires_at",
  "revoked_at",
] as const;

function toApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseKeyScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** The preset scopes and the extra scopes, without duplicates, in the canonical order. */
export function resolveKeyScopes(
  preset: keyof typeof API_KEY_PRESETS | undefined,
  scopes: readonly ApiKeyScope[] | undefined,
): ApiKeyScope[] {
  const chosen = new Set<ApiKeyScope>([
    ...(preset ? API_KEY_PRESETS[preset].scopes : []),
    ...(scopes ?? []),
  ]);
  return API_KEY_SCOPES.filter((scope) => chosen.has(scope));
}

export const apiKeysCreate = defineOperation({
  id: "api_keys.create",
  summary: "Create an API key",
  description:
    "Creates a key for the current workspace from a preset, a list of scopes, or both. " +
    "The response holds the key. It is shown once. This route ignores Idempotency-Key, " +
    "so the key is never stored for a replay.",
  method: "post",
  path: "/api-keys",
  scope: "workspace:admin",
  risk: "write",
  mcp: API_KEY_MCP,
  sensitiveOutput: true,
  input: z.object({
    name: z.string().trim().min(1).max(100),
    preset: z.enum(PRESET_IDS).optional(),
    scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).optional(),
    expiresAt: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .meta({ description: "Unix milliseconds. Omit or null for a key that does not expire." }),
  }),
  output: CreatedApiKeySchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    const scopes = resolveKeyScopes(input.preset, input.scopes);
    if (scopes.length === 0) {
      throw new OperationError("invalid_input", "Choose a preset or at least one scope.");
    }
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && expiresAt <= now) {
      throw new OperationError("invalid_input", "The expiry time must be in the future.");
    }
    const generated = await generateApiKey();
    const row = await db.db
      .insertInto("api_keys")
      .values({
        workspace_id: principal.workspaceId,
        name: input.name,
        prefix: generated.prefix,
        key_hash: generated.keyHash,
        scopes: JSON.stringify(scopes),
        created_by_user_id: principal.actorType === "user" ? principal.actorId : null,
        last_used_at: null,
        expires_at: expiresAt,
        revoked_at: null,
        created_at: now,
      })
      .returning(API_KEY_COLUMNS)
      .executeTakeFirstOrThrow();
    return { ...toApiKey(row), key: generated.key };
  },
  // Never the key. The scopes and the preset tell what the key can do.
  auditTarget: (input, output) => ({
    targetType: "api_key",
    targetId: output.id,
    metadata: { scopes: output.scopes, ...(input.preset ? { preset: input.preset } : {}) },
  }),
});

export const apiKeysList = defineOperation({
  id: "api_keys.list",
  summary: "List API keys",
  description: "Returns the workspace's keys, revoked ones included, oldest first. No key values.",
  method: "get",
  path: "/api-keys",
  scope: "workspace:admin",
  risk: "read",
  mcp: API_KEY_MCP,
  input: z.object(pageInputShape),
  output: pageOf(ApiKeySchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("api_keys")
      .select(API_KEY_COLUMNS)
      .where("workspace_id", "=", principal.workspaceId);
    if (afterId !== null) query = query.where("id", ">", afterId);
    const rows = await query.orderBy("id", "asc").limit(take).execute();
    return toPage(rows, input.limit, (row) => row.id, toApiKey);
  },
});

export const apiKeysRevoke = defineOperation({
  id: "api_keys.revoke",
  summary: "Revoke an API key",
  description: "The key fails from the next request on. Revoking a revoked key changes nothing.",
  method: "post",
  path: "/api-keys/{id}/revoke",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: API_KEY_MCP,
  input: z.object({ id: z.coerce.number().int().positive() }),
  output: ApiKeySchema,
  async handler(input, { principal, db, now }) {
    await db.db
      .updateTable("api_keys")
      .set({ revoked_at: now })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .where("revoked_at", "is", null)
      .execute();
    const row = await db.db
      .selectFrom("api_keys")
      .select(API_KEY_COLUMNS)
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "The API key does not exist.");
    return toApiKey(row);
  },
  auditTarget: (_input, output) => ({ targetType: "api_key", targetId: output.id }),
});

export const apiKeysPresets = defineOperation({
  id: "api_keys.presets",
  summary: "List API key scopes and presets",
  description: "The scopes that a key can carry, and the presets that the key form offers.",
  method: "get",
  path: "/api-keys/presets",
  scope: "workspace:admin",
  risk: "read",
  mcp: API_KEY_MCP,
  input: z.object({}),
  output: z.object({
    scopes: z.array(z.object({ scope: z.enum(API_KEY_SCOPES), description: z.string() })),
    presets: z.array(
      z.object({
        id: z.enum(PRESET_IDS),
        label: z.string(),
        scopes: z.array(z.enum(API_KEY_SCOPES)),
      }),
    ),
  }),
  async handler() {
    return {
      scopes: API_KEY_SCOPES.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] })),
      presets: PRESET_IDS.map((id) => ({
        id,
        label: API_KEY_PRESETS[id].label,
        scopes: [...API_KEY_PRESETS[id].scopes],
      })),
    };
  },
});
