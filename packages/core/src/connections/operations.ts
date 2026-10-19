import {
  ADAPTERS,
  type ConnectionCheck,
  type Credentials,
  type ProviderAdapter,
  type ProviderRefs,
  randomSecret,
} from "@envelopen/providers";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import {
  adapterContext,
  adapterOf,
  type ConnectionRow,
  ConnectionSchema,
  decryptCredentials,
  decryptWebhookSecret,
  encryptCredentials,
  encryptWebhookSecret,
  loadConnection,
  parseJson,
  refsOf,
  selectedConnectionId,
  toConnection,
  webhookBaseUrl,
  webhookUrl,
} from "./model";

// Provider connections (R9, R10, R11, KTD13, KTD14). Managing a connection is for the
// owner's session only (workspace:admin), never through an API key or MCP. Keys with
// stats:read can read the status without any secret.
//
// Connect flow: check the credentials with a cheap provider call, store them
// encrypted, then create the webhook through the provider API when the adapter can.
// When it cannot, the connection still works, and the UI shows the manual steps.

const NEVER_MCP = {
  class: "never",
  reason: "Provider connections and the policy warning are never managed through MCP.",
} as const;

// Providers ------------------------------------------------------------------------------

const ProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    policy: z.enum(["campaign", "transactional-only"]),
    policyWarning: z.string().nullable(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        secret: z.boolean(),
        required: z.boolean(),
        hint: z.string().nullable(),
        placeholder: z.string().nullable(),
        pattern: z.string().nullable(),
      }),
    ),
    autoWebhook: z.boolean(),
    eventTypes: z.array(z.string()),
    batchSize: z.number().int(),
    idempotency: z.boolean(),
    rateUnit: z.enum(["recipient", "request"]),
    ratePerSecond: z.number(),
    requiresWorkersPaid: z.boolean(),
    notes: z.array(z.string()),
    docsUrl: z.string(),
  })
  .meta({ id: "Provider" });

function describeProvider(adapter: ProviderAdapter): z.input<typeof ProviderSchema> {
  return {
    id: adapter.id,
    name: adapter.name,
    policy: adapter.policy,
    policyWarning: adapter.policyWarning ?? null,
    fields: adapter.credentialFields.map((field) => ({
      name: field.name,
      label: field.label,
      secret: field.secret,
      required: field.required,
      hint: field.hint ?? null,
      placeholder: field.placeholder ?? null,
      pattern: field.pattern ?? null,
    })),
    autoWebhook: adapter.capabilities.autoWebhook,
    eventTypes: [...adapter.capabilities.eventTypes],
    batchSize: adapter.capabilities.batchSize,
    idempotency: adapter.capabilities.idempotency,
    rateUnit: adapter.capabilities.rateUnit,
    ratePerSecond: adapter.facts.ratePerSecond,
    requiresWorkersPaid: adapter.facts.requiresWorkersPaid,
    notes: [...adapter.facts.notes],
    docsUrl: adapter.facts.docsUrl,
  };
}

export const providersList = defineOperation({
  id: "providers.list",
  summary: "List email providers",
  description:
    "Returns the providers that a workspace can connect, with their connect fields, " +
    "policy, limits, and capabilities. It holds no workspace data.",
  method: "get",
  path: "/providers",
  scope: "stats:read",
  risk: "read",
  mcp: { class: "later", reason: "Agents read connection status, not the connect form." },
  input: z.object({}),
  output: z.object({ providers: z.array(ProviderSchema) }).meta({ id: "ProviderList" }),
  async handler() {
    return { providers: ADAPTERS.map(describeProvider) };
  },
});

// Connection detail -----------------------------------------------------------------------

const WebhookSchema = z
  .object({
    url: z.string().nullable().meta({ description: "The URL that the provider calls." }),
    secret: z.string().nullable().meta({
      description:
        "Only for manual setup, when the owner copies Envelopen's secret into the provider.",
    }),
    secretSource: z.enum(["envelopen", "provider", "none"]),
    needsSecret: z.boolean().meta({
      description: "Manual setup is waiting for the owner to paste the provider's secret.",
    }),
    steps: z.array(z.string()),
  })
  .meta({ id: "ConnectionWebhook" });

export const ConnectionDetailSchema = ConnectionSchema.extend({ webhook: WebhookSchema }).meta({
  id: "ConnectionDetail",
});

async function detailOf(ctx: OperationContext, row: ConnectionRow) {
  const adapter = adapterOf(row);
  const selected = await selectedConnectionId(ctx.db, ctx.principal.workspaceId);
  const refs = refsOf(row);
  const secret = await decryptWebhookSecret(ctx.services, row);
  const base =
    refs.webhookBase ??
    (ctx.services.appOrigin ? webhookBaseUrl(ctx.services.appOrigin, row) : null);
  const manual = row.events_setup === "manual";
  const url =
    adapter.manualSecret === "none" || !base
      ? null
      : webhookUrl(adapter, base, adapter.manualSecret === "envelopen" ? secret : null);
  return {
    ...toConnection(row, selected),
    webhook: {
      url,
      // An auto-created secret stays hidden. Manual setup needs it in the provider dashboard.
      secret: manual && adapter.manualSecret === "envelopen" ? secret : null,
      secretSource: adapter.manualSecret,
      needsSecret: manual && adapter.manualSecret === "provider" && secret === null,
      steps:
        row.events_setup === "auto"
          ? []
          : adapter.manualSteps({ url: url ?? "", secret: secret ?? "" }),
    },
  };
}

// Credentials ------------------------------------------------------------------------------

/** Checks the entered fields against the adapter's fields. Returns trimmed credentials. */
export function validateCredentials(
  adapter: ProviderAdapter,
  input: Record<string, string>,
): Credentials {
  const credentials: Record<string, string> = {};
  const problems: { field: string; message: string }[] = [];
  for (const field of adapter.credentialFields) {
    const value = (input[field.name] ?? "").trim();
    if (!value) {
      if (field.required)
        problems.push({ field: field.name, message: `${field.label} is required.` });
      else if (field.defaultValue) credentials[field.name] = field.defaultValue;
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      problems.push({ field: field.name, message: `${field.label} does not look right.` });
      continue;
    }
    credentials[field.name] = value;
  }
  for (const name of Object.keys(input)) {
    if (!adapter.credentialFields.some((field) => field.name === name)) {
      problems.push({ field: name, message: `${adapter.name} has no field ${name}.` });
    }
  }
  if (problems.length > 0) {
    throw new OperationError(
      "invalid_input",
      problems[0]?.message ?? "The fields are not valid.",
      problems,
    );
  }
  return credentials;
}

/** Turns a failed check into an error. Nothing is stored for a failed connect. */
function checkError(
  adapter: ProviderAdapter,
  check: Extract<ConnectionCheck, { ok: false }>,
): OperationError {
  if (check.reason === "auth" || check.reason === "validation") {
    return new OperationError("invalid_input", check.message, { reason: check.reason });
  }
  const what =
    check.reason === "timeout"
      ? "did not answer in time"
      : check.reason === "network"
        ? "could not be reached"
        : check.reason === "rate_limited"
          ? "is limiting requests"
          : "returned an error";
  return new OperationError("provider_error", `${adapter.name} ${what}. Try again in a minute.`, {
    reason: check.reason,
  });
}

// Events setup ------------------------------------------------------------------------------

interface EventsResult {
  eventsSetup: "auto" | "manual" | "none";
  secretEncrypted: string | null;
  refs: ProviderRefs;
  /** Why automatic setup did not happen, for the warnings. */
  reason: string | null;
}

/** KTD13: create the webhook through the provider API, or prepare the manual steps. */
async function configureEvents(
  ctx: OperationContext,
  adapter: ProviderAdapter,
  row: ConnectionRow,
  credentials: Credentials,
  refs: ProviderRefs,
): Promise<EventsResult> {
  if (adapter.manualSecret === "none") {
    return { eventsSetup: "none", secretEncrypted: null, refs, reason: null };
  }
  const origin = requireService(ctx.services, "appOrigin");
  const base = webhookBaseUrl(origin, row);
  const withBase = { ...refs, webhookBase: base };
  const generated = randomSecret();
  const workspaceId = ctx.principal.workspaceId;
  let reason = "This provider has no API for webhooks.";
  if (adapter.capabilities.autoWebhook && adapter.setupEvents) {
    try {
      const setup = await adapter.setupEvents(
        credentials,
        { url: webhookUrl(adapter, base, generated), secret: generated },
        adapterContext(ctx.services, withBase),
      );
      if (setup.mode === "auto") {
        return {
          eventsSetup: "auto",
          secretEncrypted: await encryptWebhookSecret(ctx.services, workspaceId, setup.secret),
          refs: { ...withBase, ...setup.refs },
          reason: null,
        };
      }
      reason = setup.reason;
    } catch {
      reason = `${adapter.name} did not answer the webhook setup.`;
    }
  }
  return {
    eventsSetup: "manual",
    secretEncrypted:
      adapter.manualSecret === "envelopen"
        ? await encryptWebhookSecret(ctx.services, workspaceId, generated)
        : null,
    refs: withBase,
    reason,
  };
}

function manualWarning(reason: string | null): string[] {
  return reason
    ? [`Automatic webhook setup did not finish: ${reason} Follow the manual steps.`]
    : [];
}

// Operations ---------------------------------------------------------------------------------

const idInput = z.object({ id: z.coerce.number().int().positive() });

export const connectionsList = defineOperation({
  id: "connections.list",
  summary: "List provider connections",
  description:
    "Returns the workspace's provider connections and which one sends its email. No secrets.",
  method: "get",
  path: "/connections",
  scope: "stats:read",
  risk: "read",
  mcp: NEVER_MCP,
  input: z.object({}),
  output: z.object({ items: z.array(ConnectionSchema) }).meta({ id: "ConnectionList" }),
  async handler(_input, { principal, db }) {
    const [rows, selected] = await Promise.all([
      db.db
        .selectFrom("provider_connections")
        .selectAll()
        .where("workspace_id", "=", principal.workspaceId)
        .orderBy("id", "asc")
        .execute(),
      selectedConnectionId(db, principal.workspaceId),
    ]);
    return { items: rows.map((row) => toConnection(row, selected)) };
  },
});

export const connectionsGet = defineOperation({
  id: "connections.get",
  summary: "Get a provider connection",
  description:
    "Returns a connection with its webhook URL and, for manual setup, the steps and the secret to copy.",
  method: "get",
  path: "/connections/{id}",
  scope: "workspace:admin",
  risk: "read",
  mcp: NEVER_MCP,
  sensitiveOutput: true,
  input: idInput,
  output: ConnectionDetailSchema,
  async handler(input, ctx) {
    return detailOf(ctx, await loadConnection(ctx.db, ctx.principal.workspaceId, input.id));
  },
});

export const connectionsCreate = defineOperation({
  id: "connections.create",
  summary: "Connect a provider",
  description:
    "Checks the credentials with the provider, stores them encrypted, and creates the " +
    "webhook through the provider API where possible. The first connection of a " +
    "workspace becomes the one that sends its email.",
  method: "post",
  path: "/connections",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  sensitiveOutput: true,
  successStatus: 201,
  input: z.object({
    provider: z.string().min(1).max(40),
    name: z.string().trim().min(1).max(100).optional(),
    credentials: z.record(z.string(), z.string().max(4096)),
  }),
  output: ConnectionDetailSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const adapter = ADAPTERS.find((item) => item.id === input.provider);
    if (!adapter) throw new OperationError("invalid_input", `Unknown provider ${input.provider}.`);
    const credentials = validateCredentials(adapter, input.credentials);
    // Fail early, before the provider call, when the deployment has no ENCRYPTION_KEY.
    requireService(ctx.services, "credentials");

    const check = await adapter.connect(credentials, adapterContext(ctx.services, {}));
    if (!check.ok) throw checkError(adapter, check);

    const sealed = await encryptCredentials(ctx.services, principal.workspaceId, credentials);
    const inserted = await db.db
      .insertInto("provider_connections")
      .values({
        workspace_id: principal.workspaceId,
        provider: adapter.id,
        name: input.name ?? adapter.name,
        policy: adapter.policy,
        credentials_encrypted: sealed.ciphertext,
        credentials_key_version: sealed.version,
        webhook_secret_encrypted: null,
        provider_refs: JSON.stringify(check.refs ?? {}),
        status: "active",
        status_detail: null,
        policy_warning_accepted_at: null,
        policy_warning_accepted_by: null,
        account_label: check.account,
        warnings: JSON.stringify(check.warnings),
        last_checked_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const events = await configureEvents(ctx, adapter, inserted, credentials, check.refs ?? {});
    await db.atomic([
      db.db
        .updateTable("provider_connections")
        .set({
          events_setup: events.eventsSetup,
          webhook_secret_encrypted: events.secretEncrypted,
          provider_refs: JSON.stringify(events.refs),
          warnings: JSON.stringify([...check.warnings, ...manualWarning(events.reason)]),
          updated_at: now,
        })
        .where("workspace_id", "=", principal.workspaceId)
        .where("id", "=", inserted.id),
      // The first connection sends the workspace's email (KTD14).
      db.db
        .updateTable("workspaces")
        .set({ sending_connection_id: inserted.id, updated_at: now })
        .where("id", "=", principal.workspaceId)
        .where("sending_connection_id", "is", null),
    ]);
    return detailOf(ctx, await loadConnection(db, principal.workspaceId, inserted.id));
  },
  auditTarget: (_input, output) => ({
    targetType: "provider_connection",
    targetId: output.id,
    metadata: { provider: output.provider, eventsSetup: output.eventsSetup },
  }),
});

export const connectionsTest = defineOperation({
  id: "connections.test",
  summary: "Check a provider connection",
  description:
    "Checks the stored credentials with the provider again and updates the status. Sends no email.",
  method: "post",
  path: "/connections/{id}/test",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  input: idInput,
  output: ConnectionSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const row = await loadConnection(db, principal.workspaceId, input.id);
    const adapter = adapterOf(row);
    const refs = refsOf(row);
    const check = await adapter.connect(
      await decryptCredentials(ctx.services, row),
      adapterContext(ctx.services, refs),
    );
    const eventWarnings = parseJson<string[]>(row.warnings, []).filter((item) =>
      item.startsWith("Automatic webhook setup"),
    );
    await db.db
      .updateTable("provider_connections")
      .set(
        check.ok
          ? {
              status: "active",
              status_detail: null,
              account_label: check.account,
              warnings: JSON.stringify([...check.warnings, ...eventWarnings]),
              provider_refs: JSON.stringify({ ...refs, ...check.refs }),
              last_checked_at: now,
              updated_at: now,
            }
          : {
              status: "error",
              status_detail: check.message,
              last_checked_at: now,
              updated_at: now,
            },
      )
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    const selected = await selectedConnectionId(db, principal.workspaceId);
    return toConnection(await loadConnection(db, principal.workspaceId, input.id), selected);
  },
  auditTarget: (_input, output) => ({
    targetType: "provider_connection",
    targetId: output.id,
    metadata: { status: output.status },
  }),
});

export const connectionsSelect = defineOperation({
  id: "connections.select",
  summary: "Send the workspace's email through a connection",
  description:
    "Makes the connection the one that sends campaign and system email (R63). " +
    "There is no separate setting for system email.",
  method: "post",
  path: "/connections/{id}/select",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  input: idInput,
  output: ConnectionSchema,
  async handler(input, { principal, db, now }) {
    const row = await loadConnection(db, principal.workspaceId, input.id);
    if (row.status === "disabled") {
      throw new OperationError("conflict", "A disabled connection cannot send email.");
    }
    await db.db
      .updateTable("workspaces")
      .set({ sending_connection_id: row.id, updated_at: now })
      .where("id", "=", principal.workspaceId)
      .execute();
    return toConnection(row, row.id);
  },
  auditTarget: (_input, output) => ({ targetType: "provider_connection", targetId: output.id }),
});

export const connectionsAcceptPolicy = defineOperation({
  id: "connections.accept_policy",
  summary: "Accept the transactional-only warning",
  description:
    "Lets campaigns use a transactional-only connection (R62). Only the owner can " +
    "accept, and the audit log records who accepted and when.",
  method: "post",
  path: "/connections/{id}/accept-policy",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  input: idInput.extend({
    accept: z.literal(true).meta({ description: "Must be true: the owner read the warning." }),
  }),
  output: ConnectionSchema,
  async handler(input, { principal, db, now }) {
    const row = await loadConnection(db, principal.workspaceId, input.id);
    if (row.policy !== "transactional-only") {
      throw new OperationError(
        "conflict",
        "This connection is a campaign provider. It has no warning to accept.",
      );
    }
    await db.db
      .updateTable("provider_connections")
      .set({
        policy_warning_accepted_at: now,
        policy_warning_accepted_by: principal.actorId,
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", row.id)
      .execute();
    const selected = await selectedConnectionId(db, principal.workspaceId);
    return toConnection(await loadConnection(db, principal.workspaceId, row.id), selected);
  },
  auditTarget: (_input, output) => ({
    targetType: "provider_connection",
    targetId: output.id,
    metadata: { provider: output.provider, warning: output.policyWarning },
  }),
});

export const connectionsSetupEvents = defineOperation({
  id: "connections.setup_events",
  summary: "Retry the automatic webhook setup",
  description:
    "Tries again to create the webhook through the provider API. On failure, the manual steps stay.",
  method: "post",
  path: "/connections/{id}/events",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  sensitiveOutput: true,
  input: idInput,
  output: ConnectionDetailSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const row = await loadConnection(db, principal.workspaceId, input.id);
    const adapter = adapterOf(row);
    if (row.events_setup === "auto") return detailOf(ctx, row);
    const credentials = await decryptCredentials(ctx.services, row);
    const { webhookBase: _old, ...refs } = refsOf(row);
    const events = await configureEvents(ctx, adapter, row, credentials, refs);
    // A manual setup keeps its secret, so a webhook that the owner made still verifies.
    const keepSecret = events.eventsSetup === "manual" && row.webhook_secret_encrypted !== null;
    const warnings = parseJson<string[]>(row.warnings, []).filter(
      (item) => !item.startsWith("Automatic webhook setup"),
    );
    await db.db
      .updateTable("provider_connections")
      .set({
        events_setup: events.eventsSetup,
        webhook_secret_encrypted: keepSecret
          ? row.webhook_secret_encrypted
          : events.secretEncrypted,
        provider_refs: JSON.stringify(events.refs),
        warnings: JSON.stringify([...warnings, ...manualWarning(events.reason)]),
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", row.id)
      .execute();
    return detailOf(ctx, await loadConnection(db, principal.workspaceId, row.id));
  },
  auditTarget: (_input, output) => ({
    targetType: "provider_connection",
    targetId: output.id,
    metadata: { eventsSetup: output.eventsSetup },
  }),
});

export const connectionsSetWebhookSecret = defineOperation({
  id: "connections.set_webhook_secret",
  summary: "Save the provider's webhook secret",
  description:
    "For manual setup with a provider that makes its own signing secret, such as Resend: " +
    "paste the secret so Envelopen can verify the webhooks.",
  method: "post",
  path: "/connections/{id}/webhook-secret",
  scope: "workspace:admin",
  risk: "write",
  mcp: NEVER_MCP,
  input: idInput.extend({ secret: z.string().trim().min(8).max(512) }),
  output: ConnectionSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const row = await loadConnection(db, principal.workspaceId, input.id);
    const adapter = adapterOf(row);
    if (adapter.manualSecret !== "provider") {
      throw new OperationError(
        "conflict",
        `${adapter.name} uses the secret that Envelopen shows. Copy it into ${adapter.name}.`,
      );
    }
    if (adapter.id === "resend" && !input.secret.startsWith("whsec_")) {
      throw new OperationError("invalid_input", "A Resend signing secret starts with whsec_.");
    }
    const sealed = await encryptWebhookSecret(ctx.services, principal.workspaceId, input.secret);
    await db.db
      .updateTable("provider_connections")
      .set({
        // A new ENCRYPTION_KEY version must also re-encrypt the credentials, so the
        // row keeps one key version for both values.
        webhook_secret_encrypted: sealed,
        credentials_encrypted: (
          await encryptCredentials(
            ctx.services,
            principal.workspaceId,
            await decryptCredentials(ctx.services, row),
          )
        ).ciphertext,
        credentials_key_version: requireService(ctx.services, "credentials").version,
        events_setup: "manual",
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", row.id)
      .execute();
    const selected = await selectedConnectionId(db, principal.workspaceId);
    return toConnection(await loadConnection(db, principal.workspaceId, row.id), selected);
  },
  auditTarget: (_input, output) => ({ targetType: "provider_connection", targetId: output.id }),
});

export const connectionsDelete = defineOperation({
  id: "connections.delete",
  summary: "Remove a provider connection",
  description:
    "Removes the webhook that Envelopen created (best effort) and deletes the stored " +
    "credentials. Campaigns that used the connection keep their history.",
  method: "delete",
  path: "/connections/{id}",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: NEVER_MCP,
  input: idInput,
  output: z.object({ id: z.number().int(), webhookRemoved: z.boolean() }),
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const row = await loadConnection(db, principal.workspaceId, input.id);
    const adapter = adapterOf(row);
    let webhookRemoved = false;
    if (row.events_setup === "auto" && adapter.teardownEvents) {
      try {
        await adapter.teardownEvents(
          await decryptCredentials(ctx.services, row),
          adapterContext(ctx.services, refsOf(row)),
        );
        webhookRemoved = true;
      } catch {
        // The provider keeps a webhook that calls a URL that no longer verifies. Harmless.
      }
    }
    await db.atomic([
      db.db
        .updateTable("workspaces")
        .set({ sending_connection_id: null, updated_at: now })
        .where("id", "=", principal.workspaceId)
        .where("sending_connection_id", "=", row.id),
      db.db
        .deleteFrom("provider_connections")
        .where("workspace_id", "=", principal.workspaceId)
        .where("id", "=", row.id),
    ]);
    return { id: row.id, webhookRemoved };
  },
  auditTarget: (_input, output) => ({
    targetType: "provider_connection",
    targetId: output.id,
    metadata: { webhookRemoved: output.webhookRemoved },
  }),
});
