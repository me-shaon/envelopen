-- Index review for D1 rows read and rows written. D1 counts every row that a query
-- scans, foreign-key checks included, and every index adds one row written per change.
--
-- D1 enforces foreign keys. A delete of a parent row looks up its child rows by the
-- child column, so that column must lead an index. Several indexes started with
-- workspace_id, so the lookup scanned the whole child table: deleting one contact read
-- every list membership, consent event, campaign recipient, and email event, and
-- deleting a draft campaign read every email event and contact.
--
-- Without ANALYZE statistics, SQLite takes an index that starts with workspace_id for a
-- very selective one. Such an index that serves no query made the planner scan the
-- workspace instead of using a primary key.
--
-- schema.ts has no indexes, so it needs no change.

-- Contacts and memberships --------------------------------------------------------------

-- Lookups by contact (the contact view, unsubscribes, and the foreign key on delete).
-- Contact ids are unique across workspaces, so workspace_id adds nothing at the front.
DROP INDEX list_members_contact_idx;
CREATE INDEX list_members_contact_idx ON list_members (contact_id);

-- The member counts of the list and tag pages read these indexes only, with no table
-- lookup, because workspace_id is in them.
DROP INDEX list_members_list_status_idx;
CREATE INDEX list_members_list_status_idx ON list_members (list_id, workspace_id, status, contact_id);

DROP INDEX contact_tags_tag_idx;
CREATE INDEX contact_tags_tag_idx ON contact_tags (tag_id, workspace_id, contact_id);

DROP INDEX consent_events_contact_idx;
CREATE INDEX consent_events_contact_idx ON consent_events (contact_id);

-- No query filters field values by field or value. The index cost a row written on
-- every value change, and the planner chose it over the primary key.
DROP INDEX contact_field_values_field_idx;

-- Campaign recipients -------------------------------------------------------------------

-- The foreign key to contacts, the GDPR export, and erase.
CREATE INDEX campaign_recipients_contact_idx ON campaign_recipients (contact_id);

-- Only sent recipients have a provider message id. A partial index skips the snapshot
-- insert, which saves the row written that the new contact index adds.
DROP INDEX campaign_recipients_message_idx;
CREATE INDEX campaign_recipients_message_idx ON campaign_recipients (workspace_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Raw events ----------------------------------------------------------------------------

-- No query reads events by campaign and type. The foreign key to campaigns needs
-- campaign_id first: a draft delete scanned every event.
DROP INDEX email_events_campaign_type_idx;
CREATE INDEX email_events_campaign_idx ON email_events (campaign_id);

-- The GDPR export reads one contact's events in id order. The foreign key to contacts
-- needs contact_id first.
DROP INDEX email_events_contact_type_idx;
CREATE INDEX email_events_contact_idx ON email_events (contact_id);

-- Retention reads each workspace's expired events only. With occurred_at alone, every
-- hourly run scanned all events older than 30 days, expired or not.
DROP INDEX email_events_occurred_idx;
CREATE INDEX email_events_workspace_occurred_idx ON email_events (workspace_id, occurred_at);

DROP INDEX provider_events_occurred_idx;
CREATE INDEX provider_events_workspace_occurred_idx ON provider_events (workspace_id, occurred_at);

-- Other foreign keys to campaigns. Few rows have a value, so partial indexes stay small
-- and cost a row written only when a campaign sets the column.
CREATE INDEX contacts_unsubscribe_campaign_idx ON contacts (unsubscribe_campaign_id)
  WHERE unsubscribe_campaign_id IS NOT NULL;
CREATE INDEX list_members_status_campaign_idx ON list_members (status_campaign_id)
  WHERE status_campaign_id IS NOT NULL;
CREATE INDEX suppressions_campaign_idx ON suppressions (campaign_id)
  WHERE campaign_id IS NOT NULL;

-- Audit log -----------------------------------------------------------------------------

-- The audit log pages by id, newest first. An index on (workspace_id, created_at) does
-- not give id order, so each page sorted the whole workspace log. The action index
-- serves the action filter, the action list, and the onboarding check.
DROP INDEX audit_log_workspace_created_idx;
CREATE INDEX audit_log_workspace_idx ON audit_log (workspace_id);
CREATE INDEX audit_log_workspace_action_idx ON audit_log (workspace_id, action);
