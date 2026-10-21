-- Restore of an encrypted backup into a new deployment (U5, KTD3).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- Both tables are global, and no backup holds them: they record the restore into this
-- deployment, not data of the deployment that made the backup.

-- One row per restore. The first-run screen starts it before an owner exists, and the
-- restore Workflow moves it forward one backup chunk at a time
-- (packages/core/src/backup/restore.ts).
--
-- - `status`: deriving (the passphrase key derivation runs), running, waiting (for the
--   D1 daily write budget), succeeded, or failed.
-- - `source`: r2 (a backup folder `backups/<backup_id>/` in this deployment's bucket) or
--   upload (an archive file that the first-run screen stored under `source_key`).
-- - `position`: the chunks of the restore plan that are committed. A chunk and this
--   counter commit in one D1 batch, so a resumed run starts at the next chunk.
-- - `sealed_key`: the backup's data key and deployment secrets, encrypted with this
--   deployment's ENCRYPTION_KEY. It lets a later Workflow instance go on without the
--   passphrase. The end of a successful restore clears it.
-- - `owner_user_id`: the owner marker of the backup. The restore writes it last, so
--   the first-run screen stays open until every row is in.
-- - `error_code`: wrong_passphrase, invalid_backup, or failed.
CREATE TABLE restore_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'deriving'
    CHECK (status IN ('deriving', 'running', 'waiting', 'succeeded', 'failed')),
  source TEXT NOT NULL CHECK (source IN ('r2', 'upload')),
  source_key TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  backup_created_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  total_rows INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  derivation_id INTEGER,
  sealed_key TEXT,
  key_version INTEGER,
  owner_user_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  resume_at INTEGER,
  failed_step TEXT,
  error TEXT,
  error_code TEXT,
  ip TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX restore_runs_status ON restore_runs (status);

-- The progress of one table in one restore. `rows_skipped` counts rows whose foreign-key
-- parent is not in the backup (an orphan). The restore leaves them out and reports them.
CREATE TABLE restore_tables (
  run_id INTEGER NOT NULL REFERENCES restore_runs (id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  ord INTEGER NOT NULL,
  total_rows INTEGER NOT NULL,
  rows_done INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, table_name)
);
