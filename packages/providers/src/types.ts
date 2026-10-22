// The provider adapter contract (KTD12). An adapter is a plain object: data that
// describes the provider, and a few functions that talk to its API. Everything outside
// this package works through this contract, so a new provider changes nothing else
// (origin R65). The conformance kit (U18) runs the same checks on every adapter.

/** `campaign` adapters send campaigns. `transactional-only` ones need the accepted warning (R62). */
export type ProviderPolicy = "campaign" | "transactional-only";

/**
 * The provider events that Envelopen stores. They are a subset of `email_events.type`:
 * opens, clicks, and unsubscribes come from Envelopen tracking, not from providers.
 */
export type ProviderEventType =
  | "delivered"
  | "bounce_hard"
  | "bounce_soft"
  | "complaint"
  | "failed";

export const PROVIDER_EVENT_TYPES: readonly ProviderEventType[] = [
  "delivered",
  "bounce_hard",
  "bounce_soft",
  "complaint",
  "failed",
];

/** Credentials as the owner entered them, keyed by `CredentialField.name`. */
export type Credentials = Readonly<Record<string, string>>;

/** Provider-side ids that Envelopen keeps, for example a webhook id or an SNS topic ARN. */
export type ProviderRefs = Readonly<Record<string, string>>;

/** One input of the connect form. Most providers need one field (KTD13). */
export interface CredentialField {
  name: string;
  label: string;
  /** The UI hides the value, and the API never returns it. */
  secret: boolean;
  required: boolean;
  hint?: string;
  placeholder?: string;
  /** The value of an optional field that the owner leaves empty. */
  defaultValue?: string;
  /** A regular expression (source) that a value must match. */
  pattern?: string;
  /**
   * The allowed values, for a field that the form shows as a choice (the Mailgun
   * region). A value must be one of them. Give `defaultValue` too.
   */
  options?: readonly { value: string; label: string }[];
}

export interface ProviderCapabilities {
  /** Recipients per `sendBatch` call. It must fit 10 ms CPU and 50 subrequests on Free (KTD20). */
  batchSize: number;
  /**
   * A smaller batch for the Workers Free plan, when one batch of `batchSize` does not fit
   * Free's CPU limit (SMTP, Trial 1 of U17). The campaign snapshot reads the owner's
   * Workers plan setting and uses this size on Free.
   */
  batchSizeOnFree?: number;
  /** The provider accepts an idempotency key, so an uncertain batch can retry (R70). */
  idempotency: boolean;
  /** How long the provider remembers an idempotency key, in milliseconds. */
  idempotencyWindowMs: number | null;
  /** What the rate bucket counts (KTD25). */
  rateUnit: "recipient" | "request";
  /** The event types that the provider reports through its webhook. */
  eventTypes: readonly ProviderEventType[];
  /** The provider passes custom headers, such as List-Unsubscribe, through unchanged. */
  customHeaders: boolean;
  /** `setupEvents` can create the webhook through the provider API (KTD13). */
  autoWebhook: boolean;
}

/** Facts the UI shows and the rate limiter starts from (KTD16). */
export interface ProviderFacts {
  /** Steady rate in `rateUnit` per second. */
  ratePerSecond: number;
  /** The provider works only on the Workers Paid plan. */
  requiresWorkersPaid: boolean;
  /** Short facts about limits and costs, one sentence each. */
  notes: readonly string[];
  /** The provider's own documentation. */
  docsUrl: string;
}

/** DNS hints for the sending domain checks (R12). */
export interface ProviderDns {
  /** The SPF include of the provider, for example `amazonses.com`. Null when not needed. */
  spfInclude: string | null;
  /** The host that carries the SPF record, when it is not the domain itself (a return path). */
  spfHost?(domain: string): string;
  /** DKIM selectors to check when the provider API does not list the records. */
  dkimSelectors: readonly string[];
}

/** A DNS record that the owner adds at their DNS host. */
export interface DnsRecordHint {
  purpose: "spf" | "dkim" | "dmarc" | "return_path" | "tracking";
  type: "TXT" | "CNAME" | "MX";
  /** The full host name, for example `resend._domainkey.example.com`. */
  host: string;
  value: string;
}

export type MessageKind = "campaign" | "test" | "system";

/** One email to one recipient. The caller personalizes it before the call (KTD26). */
export interface OutgoingMessage {
  /** The caller's id for the recipient. The result for this message carries it back. */
  recipientId: string;
  /** Campaign and test messages must carry both unsubscribe headers (`assertMessages`). */
  kind: MessageKind;
  /** A mailbox, for example `Ana from Course Academy <ana@mail.example.com>`. */
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  /** Extra headers, sent unchanged. */
  headers: Readonly<Record<string, string>>;
}

/**
 * The result of one recipient (KTD12).
 * - `sent`: the provider accepted the message.
 * - `not_sent`: the provider refused it, so a retry cannot send a duplicate.
 * - `unknown`: a timeout, a network error, or a 5xx. The message may have gone out.
 */
export type SendOutcome = "sent" | "not_sent" | "unknown";

export type FailureReason =
  | "rate_limited"
  | "quota"
  | "credits"
  | "auth"
  | "validation"
  | "rejected"
  | "server_error"
  | "timeout"
  | "network";

export interface RecipientResult {
  recipientId: string;
  outcome: SendOutcome;
  providerMessageId?: string;
  reason?: FailureReason;
  message?: string;
}

/** A failure of the whole request. U9 pauses on `quota` and `credits`, and backs off on `rate_limited`. */
export interface BatchFailure {
  outcome: "not_sent" | "unknown";
  reason: FailureReason;
  message: string;
  /** From `Retry-After`, when the provider sends it. */
  retryAfterMs?: number;
  status?: number;
}

export interface SendBatchResult {
  /** One result per message, in the order of the messages. */
  results: RecipientResult[];
  /** Set when the whole request failed. Every result then has the failure's outcome. */
  failure?: BatchFailure;
}

/**
 * How a socket starts: `off` is plain TCP, `on` is TLS from the first byte (implicit
 * TLS, port 465), and `starttls` is plain TCP that `startTls()` upgrades later.
 */
export type SecureTransport = "off" | "on" | "starttls";

export interface SocketTarget {
  hostname: string;
  port: number;
  secureTransport: SecureTransport;
}

/**
 * A TCP socket: the subset of a `cloudflare:sockets` socket that adapters use. The
 * platform validates TLS certificates, and adapters cannot turn that off.
 */
export interface ProviderSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Settles when the socket closes. */
  readonly closed: Promise<void>;
  /**
   * Upgrades a `starttls` socket to TLS and returns the new socket. Release the
   * reader and the writer of this socket first, and use only the new one after it.
   */
  startTls(): ProviderSocket;
  close(): Promise<void>;
}

/** Opens a socket, like `connect()` of `cloudflare:sockets` with `allowHalfOpen: false`. */
export type SocketConnect = (target: SocketTarget) => ProviderSocket;

/** What every adapter call gets besides the credentials. */
export interface AdapterContext {
  /** Outbound HTTP. Tests pass a mock that replays recorded fixtures. */
  fetch: typeof fetch;
  /**
   * Outbound TCP, for adapters that do not use HTTP (SMTP, KTD12). Tests pass the mock
   * server in `conformance/mock-smtp.ts`. HTTP adapters ignore it.
   */
  connect?: SocketConnect;
  /** The refs that `connect` and `setupEvents` returned for this connection. */
  refs: ProviderRefs;
  /** Per request. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SendContext extends AdapterContext {
  /**
   * The key that the batch stored at its first claim (KTD18). Only adapters with
   * `capabilities.idempotency` use it. A retry sends the same key and the same payload.
   */
  idempotencyKey?: string;
}

/** A webhook request, with the body read once as text so verification and parsing share it. */
export interface WebhookRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A value that the provider signs once per delivery, for example the Mailgun token.
 * Envelopen records it in D1 and rejects a second request with the same value, because
 * the signature does not cover the body.
 */
export interface WebhookNonce {
  value: string;
  /** Unix milliseconds. After this time, the timestamp check rejects the request anyway. */
  expiresAt: number;
}

export type WebhookVerification =
  | { ok: true; nonce?: WebhookNonce }
  | { ok: false; reason: string };

/** A provider event in Envelopen's terms. */
export interface NormalizedEvent {
  type: ProviderEventType;
  /** A stable id of the event, so a replayed delivery is stored once. */
  eventId: string;
  providerMessageId: string | null;
  /** The recipient address as the provider reports it. */
  email: string | null;
  /** Unix milliseconds. */
  occurredAt: number;
  /** A short provider detail, for example the bounce subtype. */
  detail?: string;
}

/** A recipient who unsubscribed through the provider, for example from Brevo's own link. */
export interface ProviderUnsubscribe {
  eventId: string;
  email: string;
  providerMessageId: string | null;
  occurredAt: number;
}

export interface ParsedWebhook {
  events: NormalizedEvent[];
  /**
   * Unsubscribes that the provider reports. Envelopen applies them as unsubscribes of the
   * contact, not as provider events.
   */
  unsubscribes?: ProviderUnsubscribe[];
  /** SNS: confirm the subscription with a GET of this URL, after verification. */
  confirmSubscriptionUrl?: string;
}

export type ConnectionCheck =
  | {
      ok: true;
      /** A short description of the account, for example "us-east-1, production access". */
      account: string | null;
      /** Problems that do not stop the connection, for example the SES sandbox. */
      warnings: string[];
      /** Facts to keep with the connection, for example the SES region. */
      refs?: ProviderRefs;
    }
  | { ok: false; reason: FailureReason; message: string };

export type EventsSetup =
  | {
      mode: "auto";
      /** The secret that verifies webhooks. Some providers create their own. */
      secret: string;
      /** Provider ids to keep, so delete can remove the webhook. */
      refs: ProviderRefs;
    }
  | { mode: "manual"; reason: string };

export interface WebhookTarget {
  /** The URL that the provider must call, from `webhookUrl()`. */
  url: string;
  /** A random secret that Envelopen generated. Adapters that create their own ignore it. */
  secret: string;
}

/** A preset of the connect form (SMTP: Gmail, Google Workspace, Brevo, custom). */
export interface ProviderPreset {
  id: string;
  label: string;
  /** One sentence for the connect form. */
  description: string;
  /** Fixed values of credential fields, by field name. The form shows them read-only. */
  fixed: Readonly<Record<string, string>>;
  /** Labels and hints that replace the field's own for this preset, by field name. */
  fieldHints: Readonly<Record<string, { label?: string; hint?: string; placeholder?: string }>>;
  /** The default daily cap. The owner can change it. Null for no default. */
  defaultDailyCap: number | null;
  /** Where the cap comes from, for the form. */
  capSource: { label: string; url: string } | null;
  /** The warning that the owner accepts before the first campaign (R29). */
  policyWarning: string | null;
  /** Short notes for the form, one sentence each. */
  notes: readonly string[];
  /** Links for the form, for example the app password page. */
  links: readonly { label: string; url: string }[];
  /** The connection receives provider webhooks (bounces and complaints). */
  webhook: boolean;
}

export interface ProviderAdapter {
  /** Stable id, used in URLs and stored in `provider_connections.provider`. */
  readonly id: string;
  readonly name: string;
  readonly policy: ProviderPolicy;
  /** For `transactional-only` adapters: the warning that the owner must accept (R62). */
  readonly policyWarning?: string;
  /**
   * Presets of the connect form, for adapters that talk to many services (SMTP). Each
   * preset fills fields and carries its own cap, policy warning, and webhook.
   */
  readonly presets?: readonly ProviderPreset[];
  /**
   * For a `campaign` adapter: a warning that one connection needs from its settings, for
   * example the Gmail preset (R29). The owner accepts it before the first campaign, like
   * the warning of a transactional-only adapter. Null when the connection needs none.
   */
  connectionPolicyWarning?(refs: ProviderRefs): string | null;
  /**
   * Whether one connection receives webhooks, when it depends on its settings (an SMTP
   * preset). Without it, every connection of an adapter with a webhook receives them.
   */
  connectionHasWebhook?(refs: ProviderRefs): boolean;
  readonly credentialFields: readonly CredentialField[];
  readonly capabilities: ProviderCapabilities;
  readonly facts: ProviderFacts;
  readonly dns: ProviderDns;
  /**
   * Who makes the webhook secret in manual setup. `envelopen`: the owner copies
   * Envelopen's secret into the provider. `provider`: the owner pastes the provider's
   * secret into Envelopen. `none`: the provider has no webhook.
   */
  readonly manualSecret: "envelopen" | "provider" | "none";
  /**
   * For `manualSecret: "provider"`: the credential field that holds the provider's
   * webhook secret, when the connect form asks for it (the Mailgun signing key). Manual
   * setup then stores it too, so the owner does not paste it twice.
   */
  readonly webhookSecretField?: string;

  /** Checks the credentials with a cheap API call that sends nothing. */
  connect(credentials: Credentials, ctx: AdapterContext): Promise<ConnectionCheck>;

  /** Sends one batch. It never throws for provider errors: it returns them as results. */
  sendBatch(
    messages: readonly OutgoingMessage[],
    credentials: Credentials,
    ctx: SendContext,
  ): Promise<SendBatchResult>;

  /** The URL to give the provider. Defaults to `baseUrl`. SES and Postmark add the secret. */
  webhookUrl?(baseUrl: string, secret: string): string;

  /** True only for a request that the provider sent and that nobody changed. */
  verifyWebhook(
    request: WebhookRequest,
    secret: string,
    ctx: AdapterContext,
  ): Promise<WebhookVerification>;

  /** Normalizes a verified request. Unknown event types are skipped, not errors. */
  parseEvents(request: WebhookRequest): ParsedWebhook;

  /** Creates the webhook through the provider API (KTD13). Without it, the UI shows `manualSteps`. */
  setupEvents?(
    credentials: Credentials,
    target: WebhookTarget,
    ctx: AdapterContext,
  ): Promise<EventsSetup>;

  /** Removes what `setupEvents` created. Best effort: delete goes on when it fails. */
  teardownEvents?(credentials: Credentials, ctx: AdapterContext): Promise<void>;

  /** Steps the owner follows in the provider dashboard when auto setup is not possible. */
  manualSteps(target: WebhookTarget): string[];

  /** The exact DNS records from the provider API, when it lists them. */
  domainRecords?(
    credentials: Credentials,
    domain: string,
    ctx: AdapterContext,
  ): Promise<DnsRecordHint[] | null>;
}
