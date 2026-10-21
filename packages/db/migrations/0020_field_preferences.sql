-- Custom fields on forms and on the preference page (R14).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- `contact_fields.preference` sets what the preference page shows of a field:
--
-- - `hidden`: the page does not show the field. This is the default, so an existing
--   field stays off the page until the owner changes it.
-- - `read_only`: the page shows the value as text.
-- - `editable`: the subscriber can change the value on the page.
--
-- `forms.required_field_ids` is a JSON array of the field ids that a form requires. Each
-- id is also in `field_ids`. The service checks this before it stores the form.

ALTER TABLE contact_fields ADD COLUMN preference TEXT NOT NULL DEFAULT 'hidden'
  CHECK (preference IN ('hidden', 'read_only', 'editable'));

ALTER TABLE forms ADD COLUMN required_field_ids TEXT NOT NULL DEFAULT '[]';
