-- Sending days of capped connections (U19, R27, R28, KTD14).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- A connection with a `daily_cap` sends a large campaign over several 24-hour windows.
-- Window 0 starts when the snapshot starts, and window N starts 24 hours * N later.
--
-- `campaigns.send_window_start`: the start of window 0, or null when the connection had
-- no cap. `campaigns.send_first_capacity`: the messages that window 0 can take: the cap
-- minus the connection's sends of the last 24 hours at the start. `campaigns.send_days`:
-- the number of windows that send, or null without a cap.
--
-- `campaign_batches.send_window`: the window of the batch, or null without a cap. A
-- batch of a later window waits in `pending` with `not_before` at the window start.
--
-- `signups.deferred_origin`: the https origin of the confirmation link while the
-- confirmation email waits for the daily cap. The cron sends it when the cap has room,
-- with a new token. Null when no email waits.

ALTER TABLE campaigns ADD COLUMN send_window_start INTEGER;
ALTER TABLE campaigns ADD COLUMN send_first_capacity INTEGER;
ALTER TABLE campaigns ADD COLUMN send_days INTEGER;
ALTER TABLE campaign_batches ADD COLUMN send_window INTEGER;
ALTER TABLE signups ADD COLUMN deferred_origin TEXT;

CREATE INDEX signups_deferred ON signups (created_at) WHERE deferred_origin IS NOT NULL;
