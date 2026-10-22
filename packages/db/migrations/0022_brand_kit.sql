-- Brand kit (U13, R18, R19, KTD10).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `brand_kits`: one row per workspace. Templates use the values through reserved tokens
-- such as `{{ brand.color_primary }}`, which are filled by string substitution. The
-- values are checked on save: colors are `#rrggbb`, `font` is an id from a web-safe
-- allowlist, and each social link is an https URL. `social_links` is a JSON object from
-- network to URL. `postal_address` must be set before a campaign can be confirmed. The
-- logo columns describe the current logo, or are null when the kit has no logo.
--
-- `brand_logos`: each uploaded logo (PNG, JPEG, GIF, or WebP, at most 1 MB). The R2 key
-- is content-addressed: `brand/<workspace id>/<sha-256>.<ext>`. The row keeps a copy of
-- the bytes, so a backup holds the logo and a restored deployment can serve it again.
-- A logo is never deleted: sent emails and confirmed campaigns load it.
--
-- `campaigns.brand_snapshot`: the brand values at confirm, as JSON. The send fills the
-- tokens from it, so a later brand change does not reach a confirmed campaign.

CREATE TABLE brand_kits (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  logo_key TEXT,
  logo_content_type TEXT,
  logo_size INTEGER,
  logo_width INTEGER,
  logo_height INTEGER,
  color_primary TEXT NOT NULL DEFAULT '#4a3c77',
  color_accent TEXT NOT NULL DEFAULT '#ede9f8',
  font TEXT NOT NULL DEFAULT 'system',
  footer_text TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',
  social_links TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX brand_kits_workspace_idx ON brand_kits (workspace_id);

CREATE TABLE brand_logos (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX brand_logos_key_idx ON brand_logos (workspace_id, key);

ALTER TABLE campaigns ADD COLUMN brand_snapshot TEXT;
