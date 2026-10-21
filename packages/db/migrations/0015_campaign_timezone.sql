-- The timezone of a scheduled send (R8, KTD4).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `scheduled_at` stays the UTC instant that the cron compares with the current time.
-- These columns only record how the owner picked that instant:
--
-- - `scheduled_tz` is the IANA timezone name, for example `Asia/Dhaka`.
-- - `scheduled_local` is the wall-clock time in that zone with its UTC offset, for
--   example `2026-10-21T09:00+06:00`. The offset tells the two occurrences of a
--   fall-back hour apart.
--
-- Both are null for a campaign scheduled without a timezone (an API or MCP caller that
-- sends only `scheduledAt`) and for every campaign scheduled before this migration. The
-- app then shows the time as before.
--
-- The confirm token keeps the timezone from prepare, so confirm stores the same zone
-- that the owner reviewed.

ALTER TABLE campaigns ADD COLUMN scheduled_tz TEXT;
ALTER TABLE campaigns ADD COLUMN scheduled_local TEXT;
ALTER TABLE confirm_tokens ADD COLUMN scheduled_tz TEXT;
