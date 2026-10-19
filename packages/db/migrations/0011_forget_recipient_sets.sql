-- A frozen recipient set (`campaign_batches.recipient_set`) holds addresses, names, and
-- custom field values (KTD18). Only an open batch needs it, for an idempotent retry.
-- From now on a batch forgets its set when it is done or skipped. This migration
-- removes the sets that finished batches still hold (R21).

UPDATE campaign_batches SET recipient_set = NULL
WHERE status IN ('done', 'skipped') AND recipient_set IS NOT NULL;
