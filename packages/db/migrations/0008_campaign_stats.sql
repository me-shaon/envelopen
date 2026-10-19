-- U11: campaign stats. Human clicks per tracked link, for the click map (R47).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- The EventBuffer flush adds each human click to its link. Bot clicks never count
-- (KTD29). The counter stays when the retention job deletes the raw events (R51).
ALTER TABLE links ADD COLUMN clicks INTEGER NOT NULL DEFAULT 0;
