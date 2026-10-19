-- The EventBuffer flushes that D1 has committed (KTD31). Each flush group has an id,
-- and the flush batch records it. A group that the buffer replays after a crash
-- between the D1 commit and the local delete is then skipped, so no event counts twice.
-- The retention job deletes the rows after 7 days.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

CREATE TABLE event_flushes (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  flush_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, flush_id)
);
CREATE INDEX event_flushes_created_idx ON event_flushes (created_at);
