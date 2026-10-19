-- U9: the campaign engine. Snapshot progress, pause details, and batch dispatch state.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- JSON counts of the contacts that the snapshot left out, by reason (AE1), for example
-- {"consent_unknown": 12, "suppressed": 3, "unsubscribed": 40}.
ALTER TABLE campaigns ADD COLUMN exclusions TEXT;
-- Set when the snapshot Workflow has created every batch. A campaign cannot finish before it.
ALTER TABLE campaigns ADD COLUMN snapshot_done_at INTEGER;
-- Why the campaign paused, in words, for example the provider's error message.
ALTER TABLE campaigns ADD COLUMN pause_detail TEXT;
ALTER TABLE campaigns ADD COLUMN paused_at INTEGER;
-- The https origin of the unsubscribe and tracking links, fixed at confirm: the tracking
-- domain of the From domain, or the app's host. The queue consumer has no request to read it from.
ALTER TABLE campaigns ADD COLUMN link_origin TEXT;

-- When the batch was last put on the queue. The sweep re-dispatches a batch that stays
-- enqueued too long, for example after its message reached the dead-letter queue (KTD19).
ALTER TABLE campaign_batches ADD COLUMN dispatched_at INTEGER;
-- A batch that the provider rate-limited waits in `pending` until this time.
ALTER TABLE campaign_batches ADD COLUMN not_before INTEGER;
-- Recipient results of the batch, so the campaign view sums batches, not recipients.
ALTER TABLE campaign_batches ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_batches ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_batches ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_batches ADD COLUMN uncertain_at INTEGER;

-- The sweep finds batches that stay enqueued past the timeout, across workspaces.
CREATE INDEX campaign_batches_status_dispatched_idx ON campaign_batches (status, dispatched_at);
-- Campaign lists show the newest first.
CREATE INDEX campaigns_workspace_id_idx ON campaigns (workspace_id, id);
