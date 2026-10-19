-- Envelopen v1 initial schema.
--
-- Conventions:
-- - Times are INTEGER Unix milliseconds. Booleans are INTEGER 0 or 1. JSON is TEXT.
-- - Ids are INTEGER PRIMARY KEY (rowid alias, no AUTOINCREMENT, so no extra sqlite_sequence write).
--   `users.id` is TEXT, so it can hold the Better Auth user id.
-- - Every tenant table has `workspace_id` (KTD4). Global tables: users, workspaces, system_settings.
-- - Better Auth tables are not here. U4 generates them as a separate migration.
-- - packages/db/src/schema.ts mirrors this file. Change both together.

-- Global tables ----------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tracking_opens INTEGER NOT NULL DEFAULT 1,
  tracking_clicks INTEGER NOT NULL DEFAULT 1,
  event_retention_days INTEGER NOT NULL DEFAULT 90,
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- Workspace access ---------------------------------------------------------------

-- KTD5: v1 has one member per workspace (the owner). The role column makes v1.x members a data change.
CREATE TABLE workspace_members (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Public prefix that the UI shows to identify the key.
  prefix TEXT NOT NULL,
  -- Hash of the full key. The key itself is shown once and never stored.
  key_hash TEXT NOT NULL UNIQUE,
  -- JSON array of scopes, for example ["contacts:read"].
  scopes TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id);

-- Sensitive actions (R8). workspace_id is NULL for deployment-level actions such as setup.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER REFERENCES workspaces (id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id TEXT,
  surface TEXT NOT NULL CHECK (surface IN ('ui', 'rest', 'mcp', 'system')),
  api_key_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX audit_log_workspace_created_idx ON audit_log (workspace_id, created_at);

-- Stored responses for idempotent writes, per principal and route, kept for 24 hours.
CREATE TABLE idempotency_keys (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  expires_at INTEGER NOT NULL,
  UNIQUE (workspace_id, principal_id, method, route, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

-- Providers and domains ------------------------------------------------------------

CREATE TABLE provider_connections (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('campaign', 'transactional-only')),
  -- AES-GCM ciphertext of the credentials JSON, and the key version that encrypted it.
  credentials_encrypted TEXT NOT NULL,
  credentials_key_version INTEGER NOT NULL,
  webhook_secret_encrypted TEXT,
  -- How provider events reach Envelopen: set up through the provider API, or by manual steps.
  events_setup TEXT NOT NULL DEFAULT 'none' CHECK (events_setup IN ('auto', 'manual', 'none')),
  -- JSON with provider-side ids, for example the webhook id or the SNS topic ARN.
  provider_refs TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  status_detail TEXT,
  policy_warning_accepted_at INTEGER,
  policy_warning_accepted_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX provider_connections_workspace_idx ON provider_connections (workspace_id);

CREATE TABLE sending_domains (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES provider_connections (id) ON DELETE SET NULL,
  domain TEXT NOT NULL,
  spf_status TEXT NOT NULL DEFAULT 'unknown',
  dkim_status TEXT NOT NULL DEFAULT 'unknown',
  dmarc_status TEXT NOT NULL DEFAULT 'unknown',
  tracking_domain TEXT,
  tracking_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at INTEGER,
  verified_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, domain)
);

-- Audience ---------------------------------------------------------------------------

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Normalized address: trimmed and lowercased.
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  consent_basis TEXT NOT NULL CHECK (consent_basis IN ('existing_customer', 'explicit_opt_in', 'unknown')),
  consent_source TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  -- Where the contact came from, for example 'ui', 'import:12', or 'api_key:3'.
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, email)
);
-- Cursor pagination and the snapshot page through contacts by id within a workspace.
CREATE INDEX contacts_workspace_id_idx ON contacts (workspace_id, id);

-- Custom field definitions. The values are rows in contact_field_values, not columns.
CREATE TABLE contact_fields (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'number', 'date', 'boolean')),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, key)
);

CREATE TABLE contact_field_values (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES contact_fields (id) ON DELETE CASCADE,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (contact_id, field_id)
);
CREATE INDEX contact_field_values_field_idx ON contact_field_values (workspace_id, field_id, value);

CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX lists_workspace_idx ON lists (workspace_id);

-- R64: an unsubscribe keeps the row with status 'unsubscribed', the source, the time, and the campaign.
CREATE TABLE list_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  -- Source of the last status change, for example 'import:12', 'one_click', or 'preference_page'.
  status_source TEXT NOT NULL,
  status_at INTEGER NOT NULL,
  -- The campaign that led to the last status change, when there is one.
  status_campaign_id INTEGER REFERENCES campaigns (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX list_members_contact_idx ON list_members (workspace_id, contact_id);
CREATE INDEX list_members_list_status_idx ON list_members (list_id, status, contact_id);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, name)
);

CREATE TABLE contact_tags (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX contact_tags_tag_idx ON contact_tags (tag_id, contact_id);

-- Consent history is append-only. The services insert rows and never update them.
-- Rows are deleted only when the contact is erased (R21).
CREATE TABLE consent_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('existing_customer', 'explicit_opt_in', 'unknown')),
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX consent_events_contact_idx ON consent_events (workspace_id, contact_id, created_at);

-- Suppression keys on an HMAC of the normalized address, so it survives a contact erase.
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'soft_bounce_limit', 'manual', 'erased')),
  source TEXT,
  campaign_id INTEGER REFERENCES campaigns (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, email_hash)
);

-- Content ------------------------------------------------------------------------------

CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT,
  preheader TEXT,
  format TEXT NOT NULL CHECK (format IN ('blocks', 'html', 'markdown')),
  -- Editor blocks JSON, sanitized HTML, or Markdown, as the format says.
  source TEXT NOT NULL,
  -- Rendered output that the Worker personalizes at send time (KTD26).
  html TEXT,
  text TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX templates_workspace_idx ON templates (workspace_id);

CREATE TABLE saved_blocks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX saved_blocks_workspace_idx ON saved_blocks (workspace_id);

-- Campaigns ----------------------------------------------------------------------------

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Follow-up campaigns point at the campaign they follow.
  parent_id INTEGER REFERENCES campaigns (id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'regular' CHECK (type IN ('regular', 're-permission')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'scheduled', 'sending', 'paused', 'needs_decision', 'sent', 'cancelled')
  ),
  pause_reason TEXT CHECK (
    pause_reason IN ('manual', 'platform_limit', 'provider_quota', 'provider_credits')
  ),
  -- Each edit increments the version. A confirm token is valid for one version only.
  version INTEGER NOT NULL DEFAULT 1,
  template_id INTEGER REFERENCES templates (id) ON DELETE SET NULL,
  connection_id INTEGER REFERENCES provider_connections (id) ON DELETE SET NULL,
  subject TEXT,
  preheader TEXT,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  html TEXT,
  text TEXT,
  -- JSON with the targeted list ids and tag ids.
  audience TEXT,
  tracking_opens INTEGER NOT NULL DEFAULT 1,
  tracking_clicks INTEGER NOT NULL DEFAULT 1,
  scheduled_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  -- Stable cut for the snapshot (KTD22).
  snapshot_max_contact_id INTEGER,
  recipient_count INTEGER,
  -- The time a platform_limit pause can resume.
  resume_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX campaigns_workspace_status_idx ON campaigns (workspace_id, status);
-- The cron finds due scheduled campaigns across workspaces.
CREATE INDEX campaigns_status_scheduled_idx ON campaigns (status, scheduled_at);

CREATE TABLE campaign_batches (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'enqueued', 'claimed', 'done', 'uncertain', 'skipped')
  ),
  -- Dispatch generation (KTD17). A queue message with another generation is stale.
  generation INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  -- Frozen at the first claim (KTD18): the JSON array of campaign_recipients ids in this batch.
  recipient_set TEXT,
  idempotency_key TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_claimed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (campaign_id, seq)
);
CREATE INDEX campaign_batches_campaign_status_idx ON campaign_batches (campaign_id, status);
-- The sweep finds stale enqueued batches and expired leases across workspaces.
CREATE INDEX campaign_batches_status_lease_idx ON campaign_batches (status, lease_until);

CREATE TABLE campaign_recipients (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES campaign_batches (id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  skip_reason TEXT,
  provider_message_id TEXT,
  error TEXT,
  sent_at INTEGER,
  -- First human open and click, for unique counts and follow-ups to non-openers.
  opened_at INTEGER,
  clicked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- R36: a contact receives a campaign at most once.
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX campaign_recipients_batch_idx ON campaign_recipients (batch_id);
CREATE INDEX campaign_recipients_message_idx ON campaign_recipients (workspace_id, provider_message_id);

-- Single-use confirm tokens for prepare and confirm (R68).
CREATE TABLE confirm_tokens (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  campaign_version INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('send_now', 'schedule')),
  scheduled_at INTEGER,
  estimated_recipients INTEGER,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX confirm_tokens_campaign_idx ON confirm_tokens (campaign_id);

-- Tracked links, referenced by index in the click token (KTD26).
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (campaign_id, idx)
);

-- Events and stats -----------------------------------------------------------------------

-- Raw events, kept for the retention period (R51).
CREATE TABLE email_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns (id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES campaign_recipients (id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'delivered', 'open', 'click', 'bounce_hard', 'bounce_soft', 'complaint', 'unsubscribe',
      'failed'
    )
  ),
  link_id INTEGER REFERENCES links (id) ON DELETE SET NULL,
  provider_message_id TEXT,
  -- KTD29: machine opens and bot clicks are stored and excluded from reports.
  is_machine INTEGER NOT NULL DEFAULT 0,
  is_bot INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX email_events_campaign_type_idx ON email_events (workspace_id, campaign_id, type);
CREATE INDEX email_events_contact_type_idx ON email_events (workspace_id, contact_id, type, occurred_at);
CREATE INDEX email_events_occurred_idx ON email_events (occurred_at);

-- KTD32 rollups. Dashboards read only these tables.
CREATE TABLE campaign_stats_hourly (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  -- Start of the hour in Unix milliseconds.
  hour INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  machine_opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  bot_clicks INTEGER NOT NULL DEFAULT 0,
  bounces_hard INTEGER NOT NULL DEFAULT 0,
  bounces_soft INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  unsubscribes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, hour)
);

CREATE TABLE campaign_stats_daily (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  -- UTC date, 'YYYY-MM-DD'.
  day TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  machine_opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  bot_clicks INTEGER NOT NULL DEFAULT 0,
  bounces_hard INTEGER NOT NULL DEFAULT 0,
  bounces_soft INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  unsubscribes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

CREATE TABLE workspace_stats_daily (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  bounces_hard INTEGER NOT NULL DEFAULT 0,
  bounces_soft INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  unsubscribes INTEGER NOT NULL DEFAULT 0,
  contacts_added INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
