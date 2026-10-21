-- Signup forms with double opt-in (R10, R11, R12, KTD5, KTD6, KTD7).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `forms`: one hosted and embeddable signup form. `public_id` is the random id in the
-- public URL `/f/<public_id>`, so form ids cannot be guessed or counted. `list_ids` and
-- `field_ids` are JSON arrays of ids. A list or a field that is deleted later is left out
-- when a signup is confirmed. `consent_version` goes up by one when the consent text
-- changes, so each signup records the text that the subscriber saw.
-- `allowed_origins` is a JSON array of bare origins for `frame-ancestors`. The service
-- checks each origin before it is stored.
--
-- `signups`: a pending signup until the subscriber confirms it. `list_members.status`
-- has a CHECK (subscribed, unsubscribed), so a pending signup is never a list member, and
-- campaign estimates and snapshots cannot see it (AE2). The confirmation token is stored
-- only as its SHA-256 hash. One row exists per form and address. A new submission
-- replaces the token of the row. The cron deletes rows 7 days after they were created,
-- when their token has expired.
--
-- `form_consents`: the form evidence of a consent event that a confirmed signup wrote:
-- the form, the consent text version, a keyed hash of the IP address, and the user agent.
-- It cascades with the consent event, so an erase of the contact removes it.

CREATE TABLE forms (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  list_ids TEXT NOT NULL DEFAULT '[]',
  field_ids TEXT NOT NULL DEFAULT '[]',
  consent_text TEXT NOT NULL,
  consent_version INTEGER NOT NULL DEFAULT 1,
  success_message TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  from_name TEXT,
  from_email TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX forms_workspace_idx ON forms (workspace_id, id);

CREATE TABLE signups (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  form_id INTEGER NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  field_values TEXT,
  consent_version INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  resend_count INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX signups_form_email_idx ON signups (form_id, email_hash);
CREATE INDEX signups_email_idx ON signups (workspace_id, email);
CREATE INDEX signups_created_idx ON signups (created_at);

CREATE TABLE form_consents (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  consent_event_id INTEGER NOT NULL REFERENCES consent_events (id) ON DELETE CASCADE,
  form_id INTEGER REFERENCES forms (id) ON DELETE SET NULL,
  consent_version INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX form_consents_event_idx ON form_consents (consent_event_id);
