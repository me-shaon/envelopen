-- Welcome series (R15, R16, KTD8).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `welcome_series`: one series of 1 to 5 emails for one list. `steps` is a JSON array
-- in send order. Each item has `templateId`, `subject`, and `delayMinutes` (0 to 43,200,
-- which is 30 days). The position of a step is its index plus one. The Workflow reads the
-- steps at run time by position, so an edit changes only the steps that have not run.
-- `link_origin` is the https origin of the unsubscribe links, set when the owner saves
-- the series. `entered_count` counts the contacts that started the series.
--
-- `welcome_sends`: one row per series step and contact (KTD8). The step inserts it as
-- `pending` before the provider call, then sets `sent` or `failed`. A retry skips a
-- `sent` row, and treats a `pending` row with no result as sent, because the provider
-- may have accepted the email. `skipped` records the step where a series stopped for the
-- contact (unsubscribed, suppressed, erased, left the list, or the series was turned
-- off), so a later start cannot run the series again. The rows hold no address. An erase
-- deletes the rows of the contact.

CREATE TABLE welcome_series (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  link_origin TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  entered_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX welcome_series_list_idx ON welcome_series (list_id);
CREATE INDEX welcome_series_workspace_idx ON welcome_series (workspace_id, id);

CREATE TABLE welcome_sends (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES welcome_series (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  contact_id INTEGER REFERENCES contacts (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  skip_reason TEXT,
  provider_message_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  sent_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX welcome_sends_step_contact_idx ON welcome_sends (series_id, position, contact_id);
CREATE INDEX welcome_sends_contact_idx ON welcome_sends (workspace_id, contact_id);
CREATE INDEX welcome_sends_series_idx ON welcome_sends (workspace_id, series_id, status);
