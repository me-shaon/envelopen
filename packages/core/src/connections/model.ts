import { type DbConnection, type Row, unscoped } from "@envelopen/db";
import {
  type AdapterContext,
  type Credentials,
  getAdapter,
  type ProviderAdapter,
  type ProviderRefs,
} from "@envelopen/providers";
import { z } from "zod";
import type { CredentialOwner } from "../crypto/credentials";
import { OperationError } from "../errors";
import { requireService, type Services } from "../services";

// Shared pieces of the connection operations: the output schema, the row loader, and
// the adapter context with decrypted credentials. Credentials never leave the service
// layer: no schema here has a field for them.

export type ConnectionRow = Row<"provider_connections">;

const CREDENTIALS: CredentialOwner["purpose"] = "credentials";
const WEBHOOK_SECRET: CredentialOwner["purpose"] = "webhook_secret";

export const ConnectionSchema = z
  .object({
    id: z.number().int(),
    provider: z.string(),
    providerName: z.string(),
    name: z.string(),
    policy: z.enum(["campaign", "transactional-only"]),
    status: z.enum(["active", "error", "disabled"]),
    statusDetail: z.string().nullable(),
    accountLabel: z.string().nullable(),
    warnings: z.array(z.string()),
    eventsSetup: z.enum(["auto", "manual", "none"]),
    selected: z
      .boolean()
      .meta({ description: "This connection sends all email of the workspace." }),
    policyWarning: z.string().nullable().meta({
      description:
        "The warning to accept before campaigns: of a transactional-only provider, or of the connection's preset (Gmail, R29).",
    }),
    policyWarningAcceptedAt: z.number().int().nullable(),
    preset: z.string().nullable().meta({
      description: "The preset of an SMTP connection: gmail, workspace, brevo, or custom.",
    }),
    dailyCap: z.number().int().nullable().meta({
      description: "The most messages that the connection sends in 24 hours, or null for no cap.",
    }),
    requiresWorkersPaid: z.boolean(),
    lastCheckedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
  })
  .meta({ id: "Connection" });

export type Connection = z.output<typeof ConnectionSchema>;

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The adapter of a row. A row of a removed adapter cannot be used. */
export function adapterOf(row: { provider: string }): ProviderAdapter {
  const adapter = getAdapter(row.provider);
  if (!adapter) {
    throw new OperationError(
      "conflict",
      `The provider ${row.provider} is not available in this version.`,
    );
  }
  return adapter;
}

/**
 * The warning that the owner accepts before campaigns use the connection: the adapter's
 * transactional-only warning (R62), or the warning of the connection's preset (R29), or
 * null when the connection needs none.
 */
export function connectionWarning(
  row: Pick<ConnectionRow, "provider" | "policy" | "provider_refs">,
): string | null {
  const adapter = getAdapter(row.provider);
  if (row.policy === "transactional-only") {
    return adapter?.policyWarning ?? "This provider permits transactional email only.";
  }
  return adapter?.connectionPolicyWarning?.(refsOf(row)) ?? null;
}

/** Whether the connection receives provider webhooks. */
export function connectionHasWebhook(
  adapter: ProviderAdapter,
  row: Pick<ConnectionRow, "provider_refs">,
): boolean {
  if (adapter.manualSecret === "none") return false;
  return adapter.connectionHasWebhook?.(refsOf(row)) ?? true;
}

export function toConnection(row: ConnectionRow, selectedId: number | null): Connection {
  const adapter = getAdapter(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    providerName: adapter?.name ?? row.provider,
    name: row.name,
    policy: row.policy,
    status: row.status,
    statusDetail: row.status_detail,
    accountLabel: row.account_label,
    warnings: parseJson<string[]>(row.warnings, []),
    eventsSetup: row.events_setup,
    selected: row.id === selectedId,
    policyWarning: connectionWarning(row),
    policyWarningAcceptedAt: row.policy_warning_accepted_at,
    preset: adapter?.presets ? (refsOf(row).preset ?? null) : null,
    dailyCap: row.daily_cap,
    requiresWorkersPaid: adapter?.facts.requiresWorkersPaid ?? false,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

/** The connection that sends the workspace's email, or null. */
export async function selectedConnectionId(
  db: DbConnection,
  workspaceId: number,
): Promise<number | null> {
  const row = await db.db
    .selectFrom("workspaces")
    .select("sending_connection_id")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row?.sending_connection_id ?? null;
}

export async function loadConnection(
  db: DbConnection,
  workspaceId: number,
  id: number,
): Promise<ConnectionRow> {
  const row = await db.db
    .selectFrom("provider_connections")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The connection does not exist.");
  return row;
}

export function refsOf(row: Pick<ConnectionRow, "provider_refs">): ProviderRefs {
  return parseJson<Record<string, string>>(row.provider_refs, {});
}

export async function encryptCredentials(
  services: Partial<Services>,
  workspaceId: number,
  credentials: Credentials,
  /** Binds the value to its connection. Leave it out only before the row exists. */
  connectionId?: number,
): Promise<{ ciphertext: string; version: number }> {
  const cipher = requireService(services, "credentials");
  return {
    ciphertext: await cipher.encrypt(JSON.stringify(credentials), {
      workspaceId,
      purpose: CREDENTIALS,
      connectionId,
    }),
    version: cipher.version,
  };
}

export async function decryptCredentials(
  services: Partial<Services>,
  row: Pick<
    ConnectionRow,
    "id" | "workspace_id" | "credentials_encrypted" | "credentials_key_version"
  >,
): Promise<Credentials> {
  const cipher = requireService(services, "credentials");
  const text = await cipher.decrypt(row.credentials_encrypted, row.credentials_key_version, {
    workspaceId: row.workspace_id,
    purpose: CREDENTIALS,
    connectionId: row.id,
  });
  return JSON.parse(text) as Credentials;
}

/**
 * Webhook secrets share the key version of the credentials of their row. Both are
 * written together, so a key rotation re-encrypts both.
 */
export async function encryptWebhookSecret(
  services: Partial<Services>,
  workspaceId: number,
  secret: string,
  connectionId: number,
): Promise<string> {
  return requireService(services, "credentials").encrypt(secret, {
    workspaceId,
    purpose: WEBHOOK_SECRET,
    connectionId,
  });
}

export async function decryptWebhookSecret(
  services: Partial<Services>,
  row: Pick<
    ConnectionRow,
    "id" | "workspace_id" | "webhook_secret_encrypted" | "credentials_key_version"
  >,
): Promise<string | null> {
  if (!row.webhook_secret_encrypted) return null;
  return requireService(services, "credentials").decrypt(
    row.webhook_secret_encrypted,
    row.credentials_key_version,
    { workspaceId: row.workspace_id, purpose: WEBHOOK_SECRET, connectionId: row.id },
  );
}

/**
 * Writes connections whose credentials or webhook secret are not bound to the connection
 * id again, in the `v2.` format with the current key version (crypto/credentials.ts).
 * The cron runs it in every workspace, a few rows at a time. The update only applies
 * while the row still holds the values that were read, so a concurrent change wins. A
 * row that does not decrypt stays as it is. Returns the number of rows written.
 */
export async function resealLegacyConnections(
  db: DbConnection,
  services: Partial<Services>,
  limit = 20,
): Promise<number> {
  if (!services.credentials) return 0;
  // An installation-wide job, so it reads every workspace (KTD4).
  const rows = await unscoped(db.db)
    .selectFrom("provider_connections")
    .select([
      "id",
      "workspace_id",
      "credentials_encrypted",
      "credentials_key_version",
      "webhook_secret_encrypted",
    ])
    .where((eb) =>
      eb.or([
        eb("credentials_encrypted", "not like", "v2.%"),
        eb.and([
          eb("webhook_secret_encrypted", "is not", null),
          eb("webhook_secret_encrypted", "not like", "v2.%"),
        ]),
      ]),
    )
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  let written = 0;
  for (const row of rows) {
    let credentials: Credentials;
    let secret: string | null;
    try {
      credentials = await decryptCredentials(services, row);
      secret = await decryptWebhookSecret(services, row);
    } catch (error) {
      console.error(`Connection ${row.id}: the stored credentials do not decrypt`, error);
      continue;
    }
    const sealed = await encryptCredentials(services, row.workspace_id, credentials, row.id);
    const result = await db.db
      .updateTable("provider_connections")
      .set({
        credentials_encrypted: sealed.ciphertext,
        credentials_key_version: sealed.version,
        webhook_secret_encrypted:
          secret === null
            ? null
            : await encryptWebhookSecret(services, row.workspace_id, secret, row.id),
      })
      .where("workspace_id", "=", row.workspace_id)
      .where("id", "=", row.id)
      .where("credentials_encrypted", "=", row.credentials_encrypted)
      .where("webhook_secret_encrypted", "is", row.webhook_secret_encrypted)
      .executeTakeFirst();
    written += Number(result.numUpdatedRows);
  }
  return written;
}

/** The adapter context of a connection. */
export function adapterContext(services: Partial<Services>, refs: ProviderRefs): AdapterContext {
  const ctx: AdapterContext = { fetch: requireService(services, "outboundFetch"), refs };
  if (services.connectSocket) ctx.connect = services.connectSocket;
  return ctx;
}

/** The webhook URL without the secret: `<origin>/hooks/<provider>/<workspace>/<connection>`. */
export function webhookBaseUrl(
  origin: string,
  row: Pick<ConnectionRow, "provider" | "workspace_id" | "id">,
) {
  return `${origin.replace(/\/+$/, "")}/hooks/${row.provider}/${row.workspace_id}/${row.id}`;
}

/** The webhook URL to give the provider, with the secret where the adapter needs it. */
export function webhookUrl(adapter: ProviderAdapter, base: string, secret: string | null): string {
  return secret && adapter.webhookUrl ? adapter.webhookUrl(base, secret) : base;
}
