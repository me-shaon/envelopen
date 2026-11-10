-- toSend webhook secrets (manual setup).
--
-- packages/db/src/schema.ts mirrors this file. No column changes.
--
-- toSend makes the signing secret of each webhook, and its dashboard has no field to set
-- one. Before this migration, manual setup stored a secret that Envelopen made and asked
-- the owner to copy it into toSend, which was not possible. That secret can never match a
-- toSend signature, so it is removed. The connection page then asks for the secret that
-- toSend shows. An automatic setup keeps its secret: it came from the toSend API.

UPDATE provider_connections
SET webhook_secret_encrypted = NULL
WHERE provider = 'tosend' AND events_setup = 'manual';
