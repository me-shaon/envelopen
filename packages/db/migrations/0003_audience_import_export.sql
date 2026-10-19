-- U6: contact state, CSV imports, and contact exports.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- Keyed hash of the normalized address, the same value that suppressions store. A join
-- on it finds suppressed contacts in one query, and the address itself is never hashed
-- again at send time (KTD21).
ALTER TABLE contacts ADD COLUMN email_hash TEXT;
CREATE INDEX contacts_email_hash_idx ON contacts (workspace_id, email_hash);

-- An unsubscribe from every list (F3, R64). The contact stays visible with the source,
-- the time, and the campaign. Imports and API upserts never clear it (R73).
ALTER TABLE contacts ADD COLUMN unsubscribed_at INTEGER;
ALTER TABLE contacts ADD COLUMN unsubscribe_source TEXT;
ALTER TABLE contacts ADD COLUMN unsubscribe_campaign_id INTEGER REFERENCES campaigns (id) ON DELETE SET NULL;

-- CSV imports (R15, R16). The CSV lives in R2 until the import ends. A Workflow reads it
-- in chunks, first for the preview and then for the import.
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (
    status IN ('uploaded', 'previewing', 'previewed', 'importing', 'completed', 'failed', 'expired')
  ),
  filename TEXT NOT NULL,
  -- R2 key of the uploaded CSV. NULL after the file is deleted.
  file_key TEXT,
  size_bytes INTEGER NOT NULL,
  -- JSON array of the column names in the header row.
  headers TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT ',',
  -- JSON: column index to field. Set by the preview request.
  mapping TEXT,
  consent_basis TEXT CHECK (consent_basis IN ('existing_customer', 'explicit_opt_in', 'unknown')),
  -- Tags and lists that every imported contact gets: JSON arrays of tag names (from the
  -- preview request), tag ids (created when the import starts), and list ids.
  tag_names TEXT,
  tag_ids TEXT,
  list_ids TEXT,
  -- Each preview request starts a new generation. A stale preview run cannot write its counts.
  preview_generation INTEGER NOT NULL DEFAULT 0,
  -- JSON counts: new, updated, skipped as unsubscribed or suppressed, invalid, duplicate.
  preview TEXT,
  counts TEXT,
  -- Progress of the current run: data rows read, and the byte offset of the next row.
  processed_rows INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  -- R2 key of the error file (rows that were not imported, with the reason).
  error_file_key TEXT,
  failure TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  started_at INTEGER,
  completed_at INTEGER,
  -- The uploaded file or the error file is deleted at this time.
  expires_at INTEGER NOT NULL
);
CREATE INDEX imports_workspace_idx ON imports (workspace_id, id);
-- The cron finds expired files across workspaces.
CREATE INDEX imports_expires_idx ON imports (expires_at);

-- Contact exports (R18). The file expires 24 hours after it is made.
CREATE TABLE exports (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'expired')),
  -- R2 key of the CSV. NULL after the file is deleted.
  file_key TEXT,
  filename TEXT NOT NULL,
  -- JSON with the contact filters of the export.
  filters TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX exports_workspace_idx ON exports (workspace_id, id);
CREATE INDEX exports_expires_idx ON exports (expires_at);
