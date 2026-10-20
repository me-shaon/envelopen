-- Consent safeguards for imports and deleted contacts (R16, R73).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- Who stored the import configuration (the consent basis) and who started the run, as
-- `principalKey()` values. The import decides whether it may raise a basis of `unknown`
-- from these, not from the uploader. NULL on imports from before this migration: those
-- fall back to `created_by`.
ALTER TABLE imports ADD COLUMN configured_by TEXT;
ALTER TABLE imports ADD COLUMN started_by TEXT;

-- The consent basis of a deleted contact, keyed on the same HMAC as `suppressions`. An API
-- key cannot raise a basis of `unknown`, so it must not be able to delete the contact and
-- add it again with a stronger basis. An API key that adds the address again gets the
-- stored basis instead. An owner session is not restricted. An erase removes the row:
-- the erase keeps a suppression, which blocks every send to the address.
CREATE TABLE consent_tombstones (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  consent_basis TEXT NOT NULL CHECK (consent_basis IN ('existing_customer', 'explicit_opt_in', 'unknown')),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (workspace_id, email_hash)
);
