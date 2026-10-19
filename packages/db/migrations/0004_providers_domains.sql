-- U7: provider connections, sending domains, test addresses, and provider events.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- One connection sends all email of the workspace: campaigns and system email (R63, KTD14).
ALTER TABLE workspaces ADD COLUMN sending_connection_id INTEGER REFERENCES provider_connections (id) ON DELETE SET NULL;

-- The last credential check: a short account description, JSON warnings, and the time.
ALTER TABLE provider_connections ADD COLUMN account_label TEXT;
ALTER TABLE provider_connections ADD COLUMN warnings TEXT;
ALTER TABLE provider_connections ADD COLUMN last_checked_at INTEGER;

-- Sending domain checks (R12). Statuses: unknown, pass, missing, fail, error.
-- JSON array of DKIM selectors to look up when the provider API lists no records.
ALTER TABLE sending_domains ADD COLUMN dkim_selectors TEXT;
-- JSON array of the records the owner adds, from the provider API or the defaults.
ALTER TABLE sending_domains ADD COLUMN records TEXT;
-- JSON with what each check found, for the UI.
ALTER TABLE sending_domains ADD COLUMN check_detail TEXT;

-- Addresses that may receive test sends besides the owner (R72).
CREATE TABLE test_addresses (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Normalized: trimmed and lowercased.
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, email)
);

-- Verified provider events, normalized, waiting for the event pipeline (U10). The
-- unique event id makes a replayed webhook a no-op. The address is stored as its keyed
-- hash, the same value as `contacts.email_hash`, so the row holds no address.
CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES provider_connections (id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('delivered', 'bounce_hard', 'bounce_soft', 'complaint', 'failed')),
  provider_message_id TEXT,
  email_hash TEXT,
  detail TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  -- Set when the event pipeline has applied the event.
  processed_at INTEGER,
  UNIQUE (workspace_id, provider, event_id)
);
CREATE INDEX provider_events_pending_idx ON provider_events (workspace_id, processed_at, id);
