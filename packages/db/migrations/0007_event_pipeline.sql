-- U10: the event pipeline. Indexes for the EventBuffer flush and the cron jobs.
--
-- packages/db/src/schema.ts mirrors the tables. This migration adds indexes only.

-- The soft-bounce rule counts an address's soft bounces within 30 days (R44).
CREATE INDEX provider_events_soft_bounce_idx ON provider_events (workspace_id, email_hash, type, occurred_at);
-- The cron finds provider events that no flush applied, across workspaces.
CREATE INDEX provider_events_unapplied_idx ON provider_events (processed_at, received_at);
-- The retention job deletes applied provider events by age, across workspaces (R51).
CREATE INDEX provider_events_occurred_idx ON provider_events (occurred_at);
