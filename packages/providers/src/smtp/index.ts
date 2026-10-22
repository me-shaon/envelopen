import { brevoWebhookSteps, parseBrevoEvents, verifyBrevoWebhook } from "../brevo/webhooks";
import type {
  AdapterContext,
  ConnectionCheck,
  Credentials,
  OutgoingMessage,
  ProviderAdapter,
  ProviderRefs,
  SendBatchResult,
} from "../types";
import { checkSmtp, type SmtpContext, type SmtpSettings, sendSmtpBatch } from "./client";
import { SMTP_PRESET_IDS, SMTP_PRESETS, type SmtpPresetId, smtpPreset } from "./presets";

// The SMTP adapter (U18, R25, R26, R29) on the client of client.ts and the `connect`
// capability of the adapter context (KTD12).
//
// - connect: greeting, EHLO, STARTTLS or implicit TLS, AUTH, then QUIT. It sends nothing.
// - sendBatch: one connection per batch, with one result per recipient (client.ts maps
//   the SMTP replies). SMTP has no idempotency key, so an uncertain batch is not retried.
// - Presets (presets.ts) fix the host, the port, and the TLS mode. `connect` returns the
//   preset in the refs, so the policy gate, the webhook, and the send wrapper see it.
// - Only the Brevo preset receives webhooks (brevo/webhooks.ts). Other connections get
//   no bounce feedback, and the connection page says so.

/** Trial 1 of U17: 20 messages per batch fit Workers Free, 50 fit Paid. */
export const SMTP_BATCH_SIZE = 50;
export const SMTP_BATCH_SIZE_FREE = 20;

export class SmtpSettingsError extends Error {}

/** The preset of a connection's refs, or `custom`. */
export function presetOf(refs: ProviderRefs): SmtpPresetId {
  const id = refs.preset;
  return (SMTP_PRESET_IDS as readonly string[]).includes(id ?? "")
    ? (id as SmtpPresetId)
    : "custom";
}

/** The client settings from the credentials. Throws `SmtpSettingsError`. */
export function smtpSettings(credentials: Credentials): SmtpSettings & { preset: SmtpPresetId } {
  const presetId = credentials.preset ?? "custom";
  const preset = smtpPreset(presetId);
  if (!preset) throw new SmtpSettingsError(`The preset ${presetId} is not known.`);
  const value = (name: string) => preset.fixed[name] ?? (credentials[name] ?? "").trim();
  const host = value("host").toLowerCase();
  if (!host) throw new SmtpSettingsError("Enter the SMTP host.");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    throw new SmtpSettingsError("The SMTP host is not a valid host name.");
  }
  const portText = value("port") || "587";
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65_535) {
    throw new SmtpSettingsError("The SMTP port is not valid.");
  }
  if (port === 25) {
    throw new SmtpSettingsError(
      "Port 25 is not supported. Use 587 with STARTTLS or 465 with implicit TLS.",
    );
  }
  const security = value("security") || (port === 465 ? "tls" : "starttls");
  if (security !== "starttls" && security !== "tls") {
    throw new SmtpSettingsError("The TLS mode must be starttls or tls.");
  }
  const username = (credentials.username ?? "").trim();
  let password = credentials.password ?? "";
  // Google shows app passwords in groups of four, with spaces. SMTP needs them without.
  if (presetId === "gmail" || presetId === "workspace") password = password.replace(/\s+/g, "");
  if (!username || !password) throw new SmtpSettingsError("Enter the user name and the password.");
  return { preset: presetId as SmtpPresetId, host, port, security, username, password };
}

function smtpContext(ctx: AdapterContext): SmtpContext | null {
  if (!ctx.connect) return null;
  return {
    connect: ctx.connect,
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  };
}

const NO_SOCKETS = "This deployment cannot open SMTP connections.";

function failAll(
  messages: readonly OutgoingMessage[],
  reason: "validation" | "network",
  message: string,
): SendBatchResult {
  const failure = { outcome: "not_sent" as const, reason, message };
  return {
    results: messages.map((item) => ({ recipientId: item.recipientId, ...failure })),
    failure,
  };
}

const NO_BOUNCES =
  "This connection has no provider webhook, so Envelopen gets no bounce or complaint events. Bounces arrive as emails in the sender's inbox.";

export const smtpAdapter: ProviderAdapter = {
  id: "smtp",
  name: "SMTP",
  policy: "campaign",
  presets: SMTP_PRESETS,
  credentialFields: [
    {
      name: "preset",
      label: "Preset",
      secret: false,
      required: true,
      hint: "gmail, workspace, brevo, or custom.",
      defaultValue: "custom",
      pattern: "^(gmail|workspace|brevo|custom)$",
    },
    {
      name: "host",
      label: "SMTP host",
      secret: false,
      required: false,
      placeholder: "smtp.example.com",
      pattern: "^[A-Za-z0-9.-]{1,253}$",
    },
    {
      name: "port",
      label: "Port",
      secret: false,
      required: false,
      hint: "587 for STARTTLS or 465 for implicit TLS. Port 25 is not supported.",
      placeholder: "587",
      pattern: "^\\d{1,5}$",
    },
    {
      name: "security",
      label: "TLS mode",
      secret: false,
      required: false,
      hint: "starttls on port 587, or tls for implicit TLS on port 465.",
      pattern: "^(starttls|tls)$",
    },
    {
      name: "username",
      label: "User name",
      secret: false,
      required: true,
      placeholder: "you@example.com",
    },
    {
      name: "password",
      label: "Password",
      secret: true,
      required: true,
    },
  ],
  capabilities: {
    batchSize: SMTP_BATCH_SIZE,
    batchSizeOnFree: SMTP_BATCH_SIZE_FREE,
    idempotency: false,
    idempotencyWindowMs: null,
    rateUnit: "recipient",
    // Only the Brevo preset reports events (connectionHasWebhook).
    eventTypes: ["bounce_hard", "bounce_soft", "complaint", "failed"],
    customHeaders: true,
    autoWebhook: false,
  },
  facts: {
    ratePerSecond: 5,
    requiresWorkersPaid: false,
    notes: [
      "Send through any SMTP server, with presets for Gmail, Google Workspace, and Brevo.",
      "A batch sends up to 20 messages on Workers Free and 50 on Workers Paid, on one connection.",
      "Only the Brevo preset reports bounces and complaints to Envelopen.",
      "Send from an address of the SMTP account's own domain, or the server can refuse the message.",
    ],
    docsUrl: "https://www.rfc-editor.org/rfc/rfc6409",
  },
  dns: {
    spfInclude: null,
    // Google and Brevo DKIM selectors. A custom server's selector is unknown.
    dkimSelectors: ["google", "brevo1", "brevo2"],
  },
  manualSecret: "envelopen",

  connectionPolicyWarning(refs) {
    return smtpPreset(presetOf(refs))?.policyWarning ?? null;
  },

  connectionHasWebhook(refs) {
    return smtpPreset(presetOf(refs))?.webhook === true;
  },

  async connect(credentials, ctx): Promise<ConnectionCheck> {
    let settings: ReturnType<typeof smtpSettings>;
    try {
      settings = smtpSettings(credentials);
    } catch (error) {
      if (!(error instanceof SmtpSettingsError)) throw error;
      return { ok: false, reason: "validation", message: error.message };
    }
    const smtp = smtpContext(ctx);
    if (!smtp) return { ok: false, reason: "network", message: NO_SOCKETS };
    const { preset, ...client } = settings;
    const check = await checkSmtp(client, smtp);
    if (!check.ok) {
      const message =
        check.reason === "auth" && (preset === "gmail" || preset === "workspace")
          ? `${check.message} Google needs an app password, not your normal password.`
          : check.message;
      return { ok: false, reason: check.reason, message };
    }
    const presetInfo = smtpPreset(preset);
    return {
      ok: true,
      account: `${client.username} on ${client.host}:${client.port}`,
      warnings: presetInfo?.webhook ? [] : [NO_BOUNCES],
      refs: { preset },
    };
  },

  async sendBatch(messages, credentials, ctx) {
    let settings: ReturnType<typeof smtpSettings>;
    try {
      settings = smtpSettings(credentials);
    } catch (error) {
      if (!(error instanceof SmtpSettingsError)) throw error;
      return failAll(messages, "validation", error.message);
    }
    const smtp = smtpContext(ctx);
    if (!smtp) return failAll(messages, "network", NO_SOCKETS);
    const { preset: _preset, ...client } = settings;
    return sendSmtpBatch(messages, client, smtp);
  },

  async verifyWebhook(request, secret, ctx) {
    return verifyBrevoWebhook(request, secret, ctx.refs);
  },

  parseEvents(request) {
    return parseBrevoEvents(request);
  },

  manualSteps(target) {
    if (!target.url) {
      return [
        "This SMTP connection has no webhook. Only the Brevo preset sends bounces and complaints to Envelopen.",
      ];
    }
    return brevoWebhookSteps(target);
  },
};
