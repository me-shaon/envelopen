import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// Source of truth for the TypeScript side of the schema. The SQL in
// packages/db/migrations must match it. Change both together.
//
// Times are Unix milliseconds. Booleans are 0 or 1. JSON columns are strings.

/** A column with a SQL default: optional on insert. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;
/** A column that is set on insert and never changes. */
type Immutable<T> = ColumnType<T, T, never>;

export type Bool = 0 | 1;
export type ConsentBasis = "existing_customer" | "explicit_opt_in" | "unknown";
export type ContactFieldKind = "choice" | "multi";
/** What the preference page shows of a custom field (migration 0020). */
export type FieldPreference = "hidden" | "read_only" | "editable";
export type ListMemberStatus = "subscribed" | "unsubscribed";
export type CampaignType = "regular" | "re-permission";
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "paused"
  | "needs_decision"
  | "sent"
  | "cancelled";
export type PauseReason = "manual" | "platform_limit" | "provider_quota" | "provider_credits";
export type BatchStatus = "pending" | "enqueued" | "claimed" | "done" | "uncertain" | "skipped";
export type RecipientStatus = "pending" | "sent" | "failed" | "skipped";
export type EmailEventType =
  | "delivered"
  | "open"
  | "click"
  | "bounce_hard"
  | "bounce_soft"
  | "complaint"
  | "unsubscribe"
  | "failed";
export type SuppressionReason =
  | "hard_bounce"
  | "complaint"
  | "soft_bounce_limit"
  | "manual"
  | "erased";
export type ConnectionPolicy = "campaign" | "transactional-only";
export type Surface = "ui" | "rest" | "mcp" | "system";

// Global tables ---------------------------------------------------------------

export interface UsersTable {
  id: string;
  email: string;
  name: string | null;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface WorkspacesTable {
  id: Generated<number>;
  name: string;
  tracking_opens: Defaulted<Bool>;
  tracking_clicks: Defaulted<Bool>;
  event_retention_days: Defaulted<number>;
  archived_at: number | null;
  /** The connection that sends all email of the workspace (R63). */
  sending_connection_id: Defaulted<number | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface SystemSettingsTable {
  key: string;
  value: string;
  updated_at: Defaulted<number>;
}

// Workspace access ---------------------------------------------------------------

export interface WorkspaceMembersTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  user_id: Immutable<string>;
  role: Defaulted<string>;
  created_at: Generated<number>;
}

export interface ApiKeysTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: string;
  prefix: string;
  key_hash: string;
  /** JSON array of scope strings. */
  scopes: string;
  created_by_user_id: string | null;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: Generated<number>;
}

export interface AuditLogTable {
  id: Generated<number>;
  /** NULL for deployment-level actions such as setup. */
  workspace_id: Immutable<number | null>;
  actor_type: "user" | "api_key" | "system";
  actor_id: string | null;
  surface: Surface;
  api_key_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: string | null;
  ip: string | null;
  created_at: Generated<number>;
}

export interface IdempotencyKeysTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  principal_id: string;
  method: string;
  route: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: string | null;
  created_at: Generated<number>;
  expires_at: number;
}

// Providers and domains ------------------------------------------------------------

export interface ProviderConnectionsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  provider: string;
  name: string;
  policy: ConnectionPolicy;
  credentials_encrypted: string;
  credentials_key_version: number;
  webhook_secret_encrypted: string | null;
  events_setup: Defaulted<"auto" | "manual" | "none">;
  provider_refs: string | null;
  status: Defaulted<"active" | "error" | "disabled">;
  status_detail: string | null;
  policy_warning_accepted_at: number | null;
  policy_warning_accepted_by: string | null;
  /** A short description of the provider account from the last check. */
  account_label: Defaulted<string | null>;
  /** JSON array of warnings from the last check. */
  warnings: Defaulted<string | null>;
  last_checked_at: Defaulted<number | null>;
  /** The most messages in 24 hours, or null for no cap (migration 0023, U19 enforces it). */
  daily_cap: Defaulted<number | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface SendingDomainsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  connection_id: number | null;
  domain: string;
  spf_status: Defaulted<string>;
  dkim_status: Defaulted<string>;
  dmarc_status: Defaulted<string>;
  tracking_domain: string | null;
  tracking_status: Defaulted<string>;
  last_checked_at: number | null;
  verified_at: number | null;
  /** JSON array of DKIM selectors. */
  dkim_selectors: Defaulted<string | null>;
  /** JSON array of the DNS records to add. */
  records: Defaulted<string | null>;
  /** JSON with the findings of the last check. */
  check_detail: Defaulted<string | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export type DomainCheckStatus = "unknown" | "pass" | "missing" | "fail" | "error";

export interface TestAddressesTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  email: string;
  created_at: Generated<number>;
}

export type ProviderEventType =
  | "delivered"
  | "bounce_hard"
  | "bounce_soft"
  | "complaint"
  | "failed";

export interface ProviderEventsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  connection_id: number | null;
  provider: string;
  event_id: string;
  type: ProviderEventType;
  provider_message_id: string | null;
  /** Keyed hash of the normalized address, as in `contacts.email_hash`. */
  email_hash: string | null;
  detail: string | null;
  occurred_at: number;
  received_at: Generated<number>;
  processed_at: Defaulted<number | null>;
}

// Audience ---------------------------------------------------------------------------

export interface ContactsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  /** Normalized: trimmed and lowercased. */
  email: string;
  first_name: string | null;
  last_name: string | null;
  consent_basis: ConsentBasis;
  consent_source: string;
  consent_at: number;
  source: string;
  /** Keyed hash of the normalized address, as in `suppressions.email_hash`. */
  email_hash: string | null;
  /** Unsubscribed from every list (R64). Imports and API upserts never clear it (R73). */
  unsubscribed_at: number | null;
  unsubscribe_source: string | null;
  unsubscribe_campaign_id: number | null;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface ContactFieldsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  key: string;
  label: string;
  type: Defaulted<"text" | "number" | "date" | "boolean">;
  /** Null for a plain field. A choice field keeps `type` 'text' (migration 0018). */
  kind: Defaulted<ContactFieldKind | null>;
  /** What the preference page shows of the field (migration 0020). */
  preference: Defaulted<FieldPreference>;
  created_at: Generated<number>;
}

/** The options of a choice field. Values store the option id (migration 0018). */
export interface ContactFieldOptionsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  field_id: Immutable<number>;
  label: string;
  position: number;
  created_at: Generated<number>;
}

export interface ContactFieldValuesTable {
  workspace_id: Immutable<number>;
  contact_id: number;
  field_id: number;
  value: string | null;
  updated_at: Defaulted<number>;
}

export interface ListsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: string;
  description: string | null;
  /** Kept by triggers on list_members (migration 0014). Only the recount writes it. */
  subscribed_count: ColumnType<number, never, number>;
  unsubscribed_count: ColumnType<number, never, number>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface ListMembersTable {
  workspace_id: Immutable<number>;
  list_id: number;
  contact_id: number;
  status: ListMemberStatus;
  status_source: string;
  status_at: number;
  status_campaign_id: number | null;
  created_at: Generated<number>;
}

export interface TagsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: string;
  /** Kept by triggers on contact_tags (migration 0014). Only the recount writes it. */
  contact_count: ColumnType<number, never, number>;
  created_at: Generated<number>;
}

export interface ContactTagsTable {
  workspace_id: Immutable<number>;
  contact_id: number;
  tag_id: number;
  created_at: Generated<number>;
}

/** Append-only. Services insert rows and never update them. */
export interface ConsentEventsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  contact_id: Immutable<number>;
  basis: Immutable<ConsentBasis>;
  source: Immutable<string>;
  actor_type: Immutable<string | null>;
  actor_id: Immutable<string | null>;
  note: Immutable<string | null>;
  created_at: Generated<number>;
}

/**
 * The consent basis of a deleted contact, keyed on the suppression hash (0013). An API key
 * that adds the address again cannot set a stronger basis than this one.
 */
export interface ConsentTombstonesTable {
  workspace_id: Immutable<number>;
  /** HMAC of the normalized address, as in `suppressions.email_hash`. */
  email_hash: string;
  consent_basis: ConsentBasis;
  created_at: Generated<number>;
}

export interface SuppressionsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  /** HMAC of the normalized address. */
  email_hash: string;
  reason: SuppressionReason;
  source: string | null;
  campaign_id: number | null;
  created_at: Generated<number>;
}

export type ImportStatus =
  | "uploaded"
  | "previewing"
  | "previewed"
  | "importing"
  | "completed"
  | "failed"
  | "expired";

export interface ImportsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  status: Defaulted<ImportStatus>;
  filename: string;
  /** R2 key of the uploaded CSV. NULL after the file is deleted. */
  file_key: string | null;
  size_bytes: number;
  /** JSON array of the header names. */
  headers: string;
  delimiter: Defaulted<string>;
  /** JSON mapping of column index to field. */
  mapping: string | null;
  consent_basis: ConsentBasis | null;
  /** JSON array of tag names, from the preview request. */
  tag_names: string | null;
  /** JSON array of tag ids, resolved when the import starts. */
  tag_ids: string | null;
  /** JSON array of list ids. */
  list_ids: string | null;
  preview_generation: Defaulted<number>;
  /** JSON counts of the preview run. */
  preview: string | null;
  /** JSON counts of the import run. */
  counts: string | null;
  processed_rows: Defaulted<number>;
  cursor_offset: Defaulted<number>;
  rows_written: Defaulted<number>;
  error_count: Defaulted<number>;
  error_file_key: string | null;
  failure: string | null;
  created_by: string;
  /** `principalKey()` of who stored the configuration. NULL before 0013: use created_by. */
  configured_by: Defaulted<string | null>;
  /** `principalKey()` of who started the import run. */
  started_by: Defaulted<string | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number;
}

export interface ExportsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  status: Defaulted<"ready" | "expired">;
  /** R2 key of the CSV. NULL after the file is deleted. */
  file_key: string | null;
  filename: string;
  /** JSON with the contact filters. */
  filters: string;
  row_count: number;
  size_bytes: number;
  created_by: string;
  created_at: Generated<number>;
  expires_at: number;
}

// Content ------------------------------------------------------------------------------

export interface TemplatesTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: string;
  subject: string | null;
  preheader: string | null;
  format: "blocks" | "html" | "markdown";
  source: string;
  html: string | null;
  text: string | null;
  /** The block schema version of the editor JSON. Null for HTML and Markdown. */
  editor_version: number | null;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface SavedBlocksTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: string;
  /** JSON list of editor block nodes. */
  content: string;
  editor_version: Defaulted<number>;
  /** Sanitized HTML of the blocks, for the block panel preview. */
  html: string | null;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

// Campaigns ----------------------------------------------------------------------------

export interface CampaignsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  parent_id: number | null;
  type: Defaulted<CampaignType>;
  name: string;
  status: Defaulted<CampaignStatus>;
  pause_reason: PauseReason | null;
  version: Defaulted<number>;
  template_id: number | null;
  connection_id: number | null;
  subject: string | null;
  preheader: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  html: string | null;
  text: string | null;
  /** JSON with the targeted list ids and tag ids. */
  audience: string | null;
  tracking_opens: Defaulted<Bool>;
  tracking_clicks: Defaulted<Bool>;
  scheduled_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  snapshot_max_contact_id: number | null;
  recipient_count: number | null;
  resume_at: number | null;
  /** JSON counts of the contacts that the snapshot left out, by reason (AE1). */
  exclusions: Defaulted<string | null>;
  /** Set when the snapshot has created every batch. */
  snapshot_done_at: Defaulted<number | null>;
  pause_detail: Defaulted<string | null>;
  paused_at: Defaulted<number | null>;
  /** The https origin of unsubscribe and tracking links, fixed at confirm. */
  link_origin: Defaulted<string | null>;
  /**
   * The tracking that applies to the send, fixed at confirm: the campaign switch and the
   * workspace switch. Null before confirm.
   */
  send_tracking_opens: Defaulted<Bool | null>;
  send_tracking_clicks: Defaulted<Bool | null>;
  /** The IANA timezone that the owner scheduled in (KTD4). Null means UTC only. */
  scheduled_tz: Defaulted<string | null>;
  /** The wall-clock time in `scheduled_tz` with its UTC offset, e.g. `2026-10-21T09:00+06:00`. */
  scheduled_local: Defaulted<string | null>;
  /** JSON of the brand values at confirm (0022_brand_kit.sql). Null before confirm. */
  brand_snapshot: Defaulted<string | null>;
  /** The start of sending window 0 of a capped connection (0024_send_windows.sql). */
  send_window_start: Defaulted<number | null>;
  /** The messages that window 0 can take: the cap minus the sends of the last 24 hours. */
  send_first_capacity: Defaulted<number | null>;
  /** The number of 24-hour windows that send, or null without a daily cap. */
  send_days: Defaulted<number | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface CampaignBatchesTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  campaign_id: Immutable<number>;
  seq: Immutable<number>;
  status: Defaulted<BatchStatus>;
  generation: Defaulted<number>;
  lease_until: number | null;
  /**
   * The frozen recipient set (JSON), stored at the first claim. It holds personal data,
   * so a done or skipped batch drops it, and an erase removes the contact from it.
   */
  recipient_set: string | null;
  idempotency_key: string | null;
  recipient_count: Defaulted<number>;
  attempts: Defaulted<number>;
  first_claimed_at: number | null;
  last_error: string | null;
  /** When the batch was last put on the queue. */
  dispatched_at: Defaulted<number | null>;
  /** A rate-limited batch waits in `pending` until this time. */
  not_before: Defaulted<number | null>;
  sent_count: Defaulted<number>;
  failed_count: Defaulted<number>;
  skipped_count: Defaulted<number>;
  uncertain_at: Defaulted<number | null>;
  /** The 24-hour window of a capped connection that the batch sends in, or null. */
  send_window: Defaulted<number | null>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

export interface CampaignRecipientsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  campaign_id: Immutable<number>;
  batch_id: number | null;
  contact_id: number | null;
  status: Defaulted<RecipientStatus>;
  skip_reason: string | null;
  provider_message_id: string | null;
  error: string | null;
  sent_at: number | null;
  opened_at: number | null;
  clicked_at: number | null;
  created_at: Generated<number>;
}

export interface ConfirmTokensTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  campaign_id: Immutable<number>;
  token_hash: Immutable<string>;
  campaign_version: Immutable<number>;
  actor_type: Immutable<string>;
  actor_id: Immutable<string>;
  mode: Immutable<"send_now" | "schedule">;
  scheduled_at: number | null;
  /** The IANA timezone from prepare, for a schedule. Null means UTC only. */
  scheduled_tz: Defaulted<string | null>;
  estimated_recipients: number | null;
  expires_at: Immutable<number>;
  used_at: number | null;
  created_at: Generated<number>;
}

export interface LinksTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  campaign_id: Immutable<number>;
  idx: Immutable<number>;
  url: Immutable<string>;
  /** Human clicks on the link, from the EventBuffer flush. Bot clicks never count. */
  clicks: Defaulted<number>;
  created_at: Generated<number>;
}

// Events and stats -----------------------------------------------------------------------

export interface EmailEventsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  campaign_id: number | null;
  recipient_id: number | null;
  contact_id: number | null;
  type: EmailEventType;
  link_id: number | null;
  provider_message_id: string | null;
  is_machine: Defaulted<Bool>;
  is_bot: Defaulted<Bool>;
  data: string | null;
  occurred_at: number;
  created_at: Generated<number>;
}

interface StatCounters {
  sent: Defaulted<number>;
  delivered: Defaulted<number>;
  opens: Defaulted<number>;
  unique_opens: Defaulted<number>;
  clicks: Defaulted<number>;
  unique_clicks: Defaulted<number>;
  bounces_hard: Defaulted<number>;
  bounces_soft: Defaulted<number>;
  complaints: Defaulted<number>;
  unsubscribes: Defaulted<number>;
}

/** A one-time webhook token that the hook route has seen (migration 0025, Mailgun). */
export interface WebhookNoncesTable {
  workspace_id: Immutable<number>;
  connection_id: number;
  nonce: string;
  expires_at: number;
}

/** An EventBuffer flush group that D1 committed, so a replay of it is skipped. */
export interface EventFlushesTable {
  workspace_id: Immutable<number>;
  flush_id: string;
  created_at: number;
}

export interface CampaignStatsHourlyTable extends StatCounters {
  workspace_id: Immutable<number>;
  campaign_id: number;
  /** Start of the hour, Unix milliseconds. */
  hour: number;
  machine_opens: Defaulted<number>;
  bot_clicks: Defaulted<number>;
}

export interface CampaignStatsDailyTable extends StatCounters {
  workspace_id: Immutable<number>;
  campaign_id: number;
  /** UTC date, 'YYYY-MM-DD'. */
  day: string;
  machine_opens: Defaulted<number>;
  bot_clicks: Defaulted<number>;
}

export interface WorkspaceStatsDailyTable extends StatCounters {
  workspace_id: Immutable<number>;
  day: string;
  contacts_added: Defaulted<number>;
}

// Better Auth tables -----------------------------------------------------------------------
//
// Migration 0002 creates them from the Better Auth CLI. Better Auth reads and writes
// them through its own adapter. App code reads them at most (for example the
// first-run checks). Columns keep Better Auth's camelCase names. Dates are ISO text.

export interface AuthUserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: Bool;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionTable {
  id: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface AuthAccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthPasskeyTable {
  id: string;
  name: string | null;
  publicKey: string;
  userId: string;
  credentialID: string;
  counter: number;
  deviceType: string;
  backedUp: Bool;
  transports: string | null;
  createdAt: string | null;
  aaguid: string | null;
}

// Signup forms (U8, KTD5, KTD6, KTD7) ------------------------------------------------------

/** A hosted and embeddable signup form (0019_forms_signups.sql). */
export interface FormsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  /** The random id in the public URL `/f/<public_id>`. */
  public_id: Immutable<string>;
  name: string;
  /** JSON array of list ids. */
  list_ids: Defaulted<string>;
  /** JSON array of the custom field ids that the form asks. */
  field_ids: Defaulted<string>;
  /** JSON array of the field ids that the form requires, each also in `field_ids` (0020). */
  required_field_ids: Defaulted<string>;
  consent_text: string;
  /** Goes up by one when the consent text changes. */
  consent_version: Defaulted<number>;
  success_message: string;
  /** JSON array of bare origins for `frame-ancestors`. */
  allowed_origins: Defaulted<string>;
  from_name: string | null;
  from_email: string | null;
  enabled: Defaulted<Bool>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

/** A pending signup until its confirmation (0019_forms_signups.sql). */
export interface SignupsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  form_id: Immutable<number>;
  /** The normalized address. */
  email: string;
  /** Keyed hash of the normalized address, as in `suppressions.email_hash`. */
  email_hash: string;
  /** JSON object of stored field values by field key. */
  field_values: string | null;
  consent_version: number;
  /** Keyed hash of the IP address. */
  ip_hash: string | null;
  user_agent: string | null;
  /** SHA-256 hex of the confirmation token. */
  token_hash: string;
  expires_at: number;
  resend_count: Defaulted<number>;
  /** When the last confirmation email went out, or null when none did. */
  sent_at: Defaulted<number | null>;
  confirmed_at: Defaulted<number | null>;
  /** The link origin while the confirmation email waits for the daily cap (0024), or null. */
  deferred_origin: Defaulted<string | null>;
  created_at: Generated<number>;
}

/** The form evidence of a consent event (0019_forms_signups.sql). Append-only. */
export interface FormConsentsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  consent_event_id: Immutable<number>;
  form_id: number | null;
  consent_version: Immutable<number>;
  ip_hash: Immutable<string | null>;
  user_agent: Immutable<string | null>;
  created_at: Generated<number>;
}

// Welcome series (U10, KTD8) -------------------------------------------------------------

export type WelcomeSendStatus = "pending" | "sent" | "failed" | "skipped";

/** A series of 1 to 5 emails for one list (0021_welcome_series.sql). */
export interface WelcomeSeriesTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  list_id: Immutable<number>;
  name: string;
  /** JSON array of steps in send order: `{ templateId, subject, delayMinutes }`. */
  steps: Defaulted<string>;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  /** The https origin of the unsubscribe links. */
  link_origin: string | null;
  enabled: Defaulted<Bool>;
  /** The contacts that started the series. */
  entered_count: Defaulted<number>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

/** One step of a series for one contact (0021_welcome_series.sql). */
export interface WelcomeSendsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  series_id: Immutable<number>;
  /** The position of the step, 1 to 5. */
  position: Immutable<number>;
  contact_id: number | null;
  status: Defaulted<WelcomeSendStatus>;
  skip_reason: Defaulted<string | null>;
  provider_message_id: Defaulted<string | null>;
  error: Defaulted<string | null>;
  attempts: Defaulted<number>;
  created_at: Generated<number>;
  sent_at: Defaulted<number | null>;
  updated_at: Defaulted<number>;
}

// Brand kit (U13, KTD10) ------------------------------------------------------------------

export type BrandLogoContentType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The brand kit of a workspace, one row per workspace (0022_brand_kit.sql). */
export interface BrandKitsTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  name: Defaulted<string>;
  /** The R2 key of the current logo, `brand/<workspace id>/<sha-256>.<ext>`. */
  logo_key: Defaulted<string | null>;
  logo_content_type: Defaulted<BrandLogoContentType | null>;
  logo_size: Defaulted<number | null>;
  logo_width: Defaulted<number | null>;
  logo_height: Defaulted<number | null>;
  /** `#rrggbb`. */
  color_primary: Defaulted<string>;
  color_accent: Defaulted<string>;
  /** A font id from the web-safe allowlist (packages/email-render/src/brand.ts). */
  font: Defaulted<string>;
  footer_text: Defaulted<string>;
  postal_address: Defaulted<string>;
  /** JSON object from social network to https URL. */
  social_links: Defaulted<string>;
  created_at: Generated<number>;
  updated_at: Defaulted<number>;
}

/** An uploaded logo with a copy of its bytes, for backups (0022_brand_kit.sql). */
export interface BrandLogosTable {
  id: Generated<number>;
  workspace_id: Immutable<number>;
  key: Immutable<string>;
  content_type: Immutable<BrandLogoContentType>;
  size: Immutable<number>;
  width: Immutable<number | null>;
  height: Immutable<number | null>;
  bytes: Immutable<Uint8Array>;
  created_at: Generated<number>;
}

// Backups (U4, KTD2) ---------------------------------------------------------------------

export type BackupRunStatus = "running" | "succeeded" | "partial" | "failed";
export type BackupTrigger = "schedule" | "manual";

/** One row (id = 1): backup settings and the public key material (0016_backups.sql). */
export interface BackupSettingsTable {
  id: number;
  enabled: Defaulted<Bool>;
  retention_days: Defaulted<number>;
  /** X25519 public key, base64url. */
  public_key: Defaulted<string | null>;
  kdf_salt: Defaulted<string | null>;
  kdf_iterations: Defaulted<number | null>;
  verifier: Defaulted<string | null>;
  verifier_salt: Defaulted<string | null>;
  verifier_iterations: Defaulted<number | null>;
  key_set_at: Defaulted<number | null>;
  /** Encrypted JSON of the S3-compatible destination. */
  s3_config: Defaulted<string | null>;
  s3_key_version: Defaulted<number | null>;
  updated_at: Defaulted<number>;
}

export interface BackupRunsTable {
  id: Generated<number>;
  backup_id: Immutable<string>;
  status: Defaulted<BackupRunStatus>;
  trigger: Immutable<BackupTrigger>;
  started_at: Immutable<number>;
  finished_at: Defaulted<number | null>;
  chunk_count: Defaulted<number>;
  row_count: Defaulted<number>;
  size_bytes: Defaulted<number>;
  rows_read: Defaulted<number>;
  read_day: Defaulted<string | null>;
  rows_read_day: Defaulted<number>;
  /** JSON array, for example `["r2","s3"]`. */
  destinations: Defaulted<string>;
  error: Defaulted<string | null>;
  s3_error: Defaulted<string | null>;
  deleted_at: Defaulted<number | null>;
}

export type KeyDerivationPurpose = "setup" | "unwrap";
export type KeyDerivationStatus = "pending" | "ready" | "failed";

/** A passphrase key derivation in steps (0016_backups.sql). */
export interface KeyDerivationsTable {
  id: Generated<number>;
  purpose: Immutable<KeyDerivationPurpose>;
  status: Defaulted<KeyDerivationStatus>;
  kdf_salt: Immutable<string>;
  kdf_iterations: Immutable<number>;
  done_iterations: Defaulted<number>;
  verifier_salt: Immutable<string>;
  verifier_iterations: Immutable<number>;
  public_key: Defaulted<string | null>;
  verifier: Defaulted<string | null>;
  sealed_secret: Defaulted<string | null>;
  sealed_state: Defaulted<string | null>;
  sealed_result: Defaulted<string | null>;
  key_version: Defaulted<number | null>;
  error: Defaulted<string | null>;
  created_at: Immutable<number>;
  finished_at: Defaulted<number | null>;
}

export type RestoreRunStatus = "deriving" | "running" | "waiting" | "succeeded" | "failed";
export type RestoreSource = "r2" | "upload";

/** One restore of a backup into this deployment (0017_restore.sql). */
export interface RestoreRunsTable {
  id: Generated<number>;
  status: Defaulted<RestoreRunStatus>;
  source: RestoreSource;
  source_key: string;
  backup_id: string;
  backup_created_at: number;
  schema_version: number;
  total_rows: number;
  chunk_count: number;
  derivation_id: Defaulted<number | null>;
  /** The data key and the backup's secrets, sealed with ENCRYPTION_KEY. */
  sealed_key: Defaulted<string | null>;
  key_version: Defaulted<number | null>;
  owner_user_id: Defaulted<string | null>;
  position: Defaulted<number>;
  rows_inserted: Defaulted<number>;
  rows_skipped: Defaulted<number>;
  rows_written: Defaulted<number>;
  generation: Defaulted<number>;
  resume_at: Defaulted<number | null>;
  failed_step: Defaulted<string | null>;
  error: Defaulted<string | null>;
  error_code: Defaulted<string | null>;
  ip: Defaulted<string | null>;
  started_at: number;
  updated_at: number;
  finished_at: Defaulted<number | null>;
}

/** The progress of one table in one restore (0017_restore.sql). */
export interface RestoreTablesTable {
  run_id: number;
  table_name: string;
  ord: number;
  total_rows: number;
  rows_done: Defaulted<number>;
  rows_skipped: Defaulted<number>;
}

// Database -------------------------------------------------------------------------------

export interface Database {
  users: UsersTable;
  workspaces: WorkspacesTable;
  system_settings: SystemSettingsTable;
  workspace_members: WorkspaceMembersTable;
  api_keys: ApiKeysTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
  provider_connections: ProviderConnectionsTable;
  sending_domains: SendingDomainsTable;
  test_addresses: TestAddressesTable;
  provider_events: ProviderEventsTable;
  contacts: ContactsTable;
  contact_fields: ContactFieldsTable;
  contact_field_values: ContactFieldValuesTable;
  contact_field_options: ContactFieldOptionsTable;
  lists: ListsTable;
  list_members: ListMembersTable;
  tags: TagsTable;
  contact_tags: ContactTagsTable;
  consent_events: ConsentEventsTable;
  suppressions: SuppressionsTable;
  consent_tombstones: ConsentTombstonesTable;
  imports: ImportsTable;
  exports: ExportsTable;
  templates: TemplatesTable;
  saved_blocks: SavedBlocksTable;
  campaigns: CampaignsTable;
  campaign_batches: CampaignBatchesTable;
  campaign_recipients: CampaignRecipientsTable;
  confirm_tokens: ConfirmTokensTable;
  links: LinksTable;
  email_events: EmailEventsTable;
  campaign_stats_hourly: CampaignStatsHourlyTable;
  campaign_stats_daily: CampaignStatsDailyTable;
  workspace_stats_daily: WorkspaceStatsDailyTable;
  event_flushes: EventFlushesTable;
  webhook_nonces: WebhookNoncesTable;
  auth_user: AuthUserTable;
  auth_session: AuthSessionTable;
  auth_account: AuthAccountTable;
  auth_verification: AuthVerificationTable;
  auth_passkey: AuthPasskeyTable;
  backup_settings: BackupSettingsTable;
  backup_runs: BackupRunsTable;
  key_derivations: KeyDerivationsTable;
  restore_runs: RestoreRunsTable;
  restore_tables: RestoreTablesTable;
  forms: FormsTable;
  signups: SignupsTable;
  form_consents: FormConsentsTable;
  welcome_series: WelcomeSeriesTable;
  welcome_sends: WelcomeSendsTable;
  brand_kits: BrandKitsTable;
  brand_logos: BrandLogosTable;
}

export type TableName = keyof Database;

/**
 * Scope of every table (KTD4). The `Record` type makes this list exhaustive: a new
 * table in `Database` does not compile until it is classified here. Global tables
 * have no `workspace_id`. Every tenant table has one.
 */
export const TABLE_SCOPE: Readonly<Record<TableName, "global" | "tenant">> = {
  users: "global",
  workspaces: "global",
  system_settings: "global",
  workspace_members: "tenant",
  api_keys: "tenant",
  audit_log: "tenant",
  idempotency_keys: "tenant",
  provider_connections: "tenant",
  sending_domains: "tenant",
  test_addresses: "tenant",
  provider_events: "tenant",
  contacts: "tenant",
  contact_fields: "tenant",
  contact_field_values: "tenant",
  contact_field_options: "tenant",
  lists: "tenant",
  list_members: "tenant",
  tags: "tenant",
  contact_tags: "tenant",
  consent_events: "tenant",
  suppressions: "tenant",
  consent_tombstones: "tenant",
  imports: "tenant",
  exports: "tenant",
  templates: "tenant",
  saved_blocks: "tenant",
  campaigns: "tenant",
  campaign_batches: "tenant",
  campaign_recipients: "tenant",
  confirm_tokens: "tenant",
  links: "tenant",
  email_events: "tenant",
  campaign_stats_hourly: "tenant",
  campaign_stats_daily: "tenant",
  workspace_stats_daily: "tenant",
  event_flushes: "tenant",
  // Better Auth tables are global (KTD4).
  auth_user: "global",
  auth_session: "global",
  auth_account: "global",
  auth_verification: "global",
  auth_passkey: "global",
  // Backups cover the whole deployment (U4).
  backup_settings: "global",
  backup_runs: "global",
  key_derivations: "global",
  // Restores into this deployment (U5).
  restore_runs: "global",
  restore_tables: "global",
  // Signup forms (U8).
  forms: "tenant",
  signups: "tenant",
  form_consents: "tenant",
  // Welcome series (U10).
  welcome_series: "tenant",
  welcome_sends: "tenant",
  // Brand kit (U13).
  brand_kits: "tenant",
  brand_logos: "tenant",
  // Webhook nonces (U20).
  webhook_nonces: "tenant",
};

export const TENANT_TABLES: ReadonlySet<string> = new Set(
  Object.entries(TABLE_SCOPE)
    .filter(([, scope]) => scope === "tenant")
    .map(([name]) => name),
);

export type Row<T extends TableName> = Selectable<Database[T]>;
export type NewRow<T extends TableName> = Insertable<Database[T]>;
export type RowUpdate<T extends TableName> = Updateable<Database[T]>;
