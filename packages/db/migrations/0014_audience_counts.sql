-- Stored member counts and an index for the audience queries. D1 bills rows read and
-- rows written, so this migration trades a few rows written per change for many rows
-- read per page view.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- Member counts ---------------------------------------------------------------------------

-- The lists page and the tags page counted every membership on each view: about 90,000
-- rows read for a list page and 60,000 for a tag page in a workspace with 50,000
-- contacts. The counts are now columns on the list and the tag.
--
-- Triggers keep the counts, not the application code. A trigger runs in the statement
-- that changes the membership, so the count commits or rolls back with it, in a D1
-- batch too. It also runs for the rows that a foreign key cascade deletes (a deleted
-- contact or list), and no write path can forget it. Each membership change costs one
-- more row written (the list or tag row). A statement that changes no row (ON CONFLICT
-- DO NOTHING, or an update to the same status) runs no trigger. No code path uses
-- INSERT OR REPLACE on these tables, which would delete rows without a delete trigger.
--
-- The cron recounts the stored counts once a day and corrects a drift (repairCounts in
-- packages/core/src/lists/counts.ts).

ALTER TABLE lists ADD COLUMN subscribed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lists ADD COLUMN unsubscribed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tags ADD COLUMN contact_count INTEGER NOT NULL DEFAULT 0;

UPDATE lists SET
  subscribed_count = (SELECT count(*) FROM list_members m
    WHERE m.list_id = lists.id AND m.workspace_id = lists.workspace_id AND m.status = 'subscribed'),
  unsubscribed_count = (SELECT count(*) FROM list_members m
    WHERE m.list_id = lists.id AND m.workspace_id = lists.workspace_id AND m.status = 'unsubscribed');

UPDATE tags SET contact_count = (SELECT count(*) FROM contact_tags ct
  WHERE ct.tag_id = tags.id AND ct.workspace_id = tags.workspace_id);

CREATE TRIGGER list_members_count_insert AFTER INSERT ON list_members BEGIN
  UPDATE lists SET
    subscribed_count = subscribed_count + (NEW.status = 'subscribed'),
    unsubscribed_count = unsubscribed_count + (NEW.status = 'unsubscribed')
  WHERE id = NEW.list_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER list_members_count_delete AFTER DELETE ON list_members BEGIN
  UPDATE lists SET
    subscribed_count = subscribed_count - (OLD.status = 'subscribed'),
    unsubscribed_count = unsubscribed_count - (OLD.status = 'unsubscribed')
  WHERE id = OLD.list_id AND workspace_id = OLD.workspace_id;
END;

-- The code changes only the status of a membership, never its list or workspace.
CREATE TRIGGER list_members_count_update AFTER UPDATE OF status ON list_members
WHEN OLD.status IS NOT NEW.status BEGIN
  UPDATE lists SET
    subscribed_count = subscribed_count + (NEW.status = 'subscribed') - (OLD.status = 'subscribed'),
    unsubscribed_count = unsubscribed_count + (NEW.status = 'unsubscribed') - (OLD.status = 'unsubscribed')
  WHERE id = NEW.list_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER contact_tags_count_insert AFTER INSERT ON contact_tags BEGIN
  UPDATE tags SET contact_count = contact_count + 1
  WHERE id = NEW.tag_id AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER contact_tags_count_delete AFTER DELETE ON contact_tags BEGIN
  UPDATE tags SET contact_count = contact_count - 1
  WHERE id = OLD.tag_id AND workspace_id = OLD.workspace_id;
END;

-- Audience queries -----------------------------------------------------------------------

-- The campaign estimate and the snapshot pages read the memberships of the targeted
-- lists (packages/core/src/campaigns/audience.ts) instead of every contact. They need
-- the members of a list in contact id order, of both statuses: a snapshot page reads a
-- range of contact ids, and its insert keeps contact id order. The old index had the
-- status before the contact id. It served the member counts, which are columns now.
-- The new index has the same columns, so a membership change costs the same rows written.
-- The contact filters of the contact list look up (list, workspace, contact) and read
-- the status from the index too.
DROP INDEX list_members_list_status_idx;
CREATE INDEX list_members_list_contact_idx ON list_members (list_id, workspace_id, contact_id, status);

-- Decisions without a schema change --------------------------------------------------------
--
-- Erase and email_events(recipient_id): no index. An index on recipient_id costs one
-- more row written for every event, the table with the most writes: 5 rows written per
-- event instead of 4. An erase is rare. An event takes its contact_id from its recipient
-- when it is stored, and a recipient's contact_id only ever changes to NULL. So the events of
-- the contact's recipients all have the contact's id, and the erase deletes by contact_id
-- through email_events_contact_idx. That read 300,000 rows before, because SQLite took
-- email_events_workspace_occurred_idx for the workspace_id condition. The erase now
-- names the contact index.
--
-- Statistics: no ANALYZE and no PRAGMA optimize. D1 supports PRAGMA optimize. With
-- statistics, the hot queries of the review changed plans: some read fewer rows, and
-- others read more (the contact list filtered by list and status, and the suppressed
-- filter, read 1,000 more rows each). The plans of the code are tuned without
-- statistics, and statistics that age would change them without a code change.
--
-- Contact search keeps its LIKE. An FTS5 trigram index is deferred: `wrangler d1 export`
-- does not support virtual tables, and trigram support on remote D1 is not verified.
--
-- The onboarding check for a sent recipient read every recipient of the database when
-- the workspace had none, because only a partial index starts with workspace_id. It now
-- goes from the workspace's campaigns to their recipients by campaign_id.
