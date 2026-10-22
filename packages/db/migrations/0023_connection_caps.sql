-- Daily caps of provider connections (U18, R27, KTD14).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `daily_cap`: the most messages that the connection may send in 24 hours, or null for
-- no cap. The SMTP presets set a default at connect: 500 for Gmail, 2,000 for Google
-- Workspace, and Brevo's free-plan limit for Brevo. The owner can change it. U19 enforces
-- the cap with a rolling counter.

ALTER TABLE provider_connections ADD COLUMN daily_cap INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0);
