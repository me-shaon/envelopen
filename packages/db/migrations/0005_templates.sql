-- U8: templates and saved blocks for the block editor.
--
-- packages/db/src/schema.ts mirrors this file. Change both together.

-- The block schema version of the editor JSON in `source` (format 'blocks'), so a later
-- editor can upgrade old documents. Null for HTML and Markdown templates.
ALTER TABLE templates ADD COLUMN editor_version INTEGER;

-- A saved block is a list of editor block nodes (JSON in `content`). The browser also
-- sends its rendered HTML, sanitized like a template, for the block panel preview.
ALTER TABLE saved_blocks ADD COLUMN editor_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE saved_blocks ADD COLUMN html TEXT;

-- Lists show the most recently edited first.
CREATE INDEX templates_updated_idx ON templates (workspace_id, updated_at);
