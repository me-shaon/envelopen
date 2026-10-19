-- The open and click tracking that applied to a send, fixed at confirm. A send tracks
-- only when the campaign switch and the workspace switch are both on. The workspace
-- switch can change later, so stats and the follow-up read these columns instead.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

ALTER TABLE campaigns ADD COLUMN send_tracking_opens INTEGER;
ALTER TABLE campaigns ADD COLUMN send_tracking_clicks INTEGER;

-- Campaigns confirmed before this migration: the same inference as before. The switches
-- of the campaign and the workspace, or a recorded event that proves the tracking.
UPDATE campaigns SET
  send_tracking_opens = CASE WHEN tracking_opens = 1 AND (
      (SELECT w.tracking_opens FROM workspaces w WHERE w.id = campaigns.workspace_id) = 1
      OR EXISTS (SELECT 1 FROM campaign_stats_daily s
        WHERE s.workspace_id = campaigns.workspace_id AND s.campaign_id = campaigns.id
          AND (s.opens > 0 OR s.machine_opens > 0))
    ) THEN 1 ELSE 0 END,
  send_tracking_clicks = CASE WHEN tracking_clicks = 1 AND (
      (SELECT w.tracking_clicks FROM workspaces w WHERE w.id = campaigns.workspace_id) = 1
      OR EXISTS (SELECT 1 FROM campaign_stats_daily s
        WHERE s.workspace_id = campaigns.workspace_id AND s.campaign_id = campaigns.id
          AND (s.clicks > 0 OR s.bot_clicks > 0))
    ) THEN 1 ELSE 0 END
WHERE link_origin IS NOT NULL;
