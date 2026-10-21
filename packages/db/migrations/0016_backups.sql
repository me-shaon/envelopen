-- Encrypted backups (U4, KTD2).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- Both tables are global: a backup covers the whole deployment, not one workspace.

-- One row per deployment (id = 1). It holds the backup settings and the public half of
-- the key that the owner's passphrase derives (packages/core/src/backup/crypto.ts).
--
-- - The passphrase and the private key are never stored. Only the passphrase holder can
--   open a backup.
-- - `kdf_salt` and `kdf_iterations` are the PBKDF2 inputs of the key derivation.
-- - `verifier`, `verifier_salt`, and `verifier_iterations` let a restore reject a wrong
--   passphrase before it tries to open the backup.
-- - `s3_config` is the optional S3-compatible copy destination (endpoint, region,
--   bucket, access key id, secret), encrypted with ENCRYPTION_KEY like provider
--   credentials. `s3_key_version` is the key version that encrypted it.
CREATE TABLE backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  retention_days INTEGER NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 1 AND 365),
  public_key TEXT,
  kdf_salt TEXT,
  kdf_iterations INTEGER,
  verifier TEXT,
  verifier_salt TEXT,
  verifier_iterations INTEGER,
  key_set_at INTEGER,
  s3_config TEXT,
  s3_key_version INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- One row per backup run. `backup_id` names the R2 prefix `backups/<backup_id>/`.
--
-- - `status`: running, succeeded, partial (R2 has the backup, the S3 copy failed), or
--   failed.
-- - `trigger`: schedule (the daily cron) or manual (the owner).
-- - `destinations`: a JSON array of the stores that hold the backup, for example
--   ["r2","s3"].
-- - `read_day` and `rows_read_day` meter the D1 rows that the run read on that UTC day,
--   so all runs of one day stay inside the read budget.
-- - `deleted_at`: retention removed the backup files. The row stays as history.
CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY,
  backup_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  read_day TEXT,
  rows_read_day INTEGER NOT NULL DEFAULT 0,
  destinations TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  s3_error TEXT,
  deleted_at INTEGER
);

CREATE INDEX backup_runs_started ON backup_runs (started_at);
CREATE INDEX backup_runs_read_day ON backup_runs (read_day);

-- One row per passphrase key derivation (KTD2). PBKDF2 with 600,000 iterations takes
-- about 40 ms of CPU, and Workers Free gives a request or a Workflow step 10 ms. So the
-- key derivation Workflow runs one segment of 100,000 iterations per step, and this row
-- carries the state between the steps (packages/core/src/backup/derivation.ts).
--
-- - `purpose`: setup (a new passphrase; the result goes to backup_settings) or unwrap
--   (U5 restore and download; the result is the sealed derivation output).
-- - `sealed_secret` (the passphrase) and `sealed_state` (the chained PBKDF2 value) are
--   encrypted with ENCRYPTION_KEY, bound to the row id. `key_version` is the key version
--   that encrypted them. Both are cleared when the derivation ends.
-- - `done_iterations` counts the iterations of the finished segments.
-- - For unwrap, `public_key` and `verifier` are the expected values from the backup, so
--   the last step rejects a wrong passphrase.
CREATE TABLE key_derivations (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'unwrap')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  kdf_salt TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  done_iterations INTEGER NOT NULL DEFAULT 0,
  verifier_salt TEXT NOT NULL,
  verifier_iterations INTEGER NOT NULL,
  public_key TEXT,
  verifier TEXT,
  sealed_secret TEXT,
  sealed_state TEXT,
  sealed_result TEXT,
  key_version INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX key_derivations_status ON key_derivations (status, created_at);
