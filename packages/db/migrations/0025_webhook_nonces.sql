-- Webhook nonces (U20, KTD15).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- Some providers sign a timestamp and a one-time token, not the body (Mailgun). A
-- captured signature could then carry another body. The hook route records each token
-- here before it stores anything, and rejects a request whose token is in the table.
-- The primary key makes the check and the record one atomic step. KV is eventually
-- consistent, so two requests with one token could both pass a KV check.
--
-- `expires_at`: when the provider's timestamp window ends. After it, the signature
-- check rejects the token anyway, so the retention job deletes the row.

CREATE TABLE webhook_nonces (
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, nonce)
);
CREATE INDEX webhook_nonces_expires_idx ON webhook_nonces (expires_at);
