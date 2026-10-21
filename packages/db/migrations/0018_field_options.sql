-- Choice custom fields (R13, KTD5).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `contact_fields.type` has a CHECK constraint (text, number, date, boolean). SQLite
-- cannot change a CHECK without a rebuild of the table, so the type stays and a new
-- nullable column marks a choice field:
--
-- - `kind` is null for a plain field, `choice` for a single choice, and `multi` for a
--   multiple choice. A choice field keeps `type` 'text'.
--
-- The options of a choice field have a stable id. A contact's value stores option ids,
-- never labels, so a rename changes only the label:
--
-- - `choice`: the option id as text, for example `12`.
-- - `multi`: a JSON array of option ids, for example `[12,15]`.
--
-- `position` sets the order of the options in the editor, on forms, and in merge tags.
-- Labels are unique per field without regard to case, because an import maps values by
-- label. The unique index uses lower(), which folds ASCII letters only.

ALTER TABLE contact_fields ADD COLUMN kind TEXT CHECK (kind IN ('choice', 'multi'));

CREATE TABLE contact_field_options (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES contact_fields (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX contact_field_options_label_idx ON contact_field_options (field_id, lower(label));
CREATE INDEX contact_field_options_field_idx ON contact_field_options (workspace_id, field_id, position);
