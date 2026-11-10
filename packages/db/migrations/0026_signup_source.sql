-- Signup source (headless signup forms).
--
-- packages/db/src/schema.ts mirrors this file. Change both together.
--
-- A signup and its consent record keep how the subscriber signed up:
--
-- - `hosted`: the hosted form page.
-- - `embed`: the hosted form in an iframe (`?embed=1`).
-- - `headless`: the JSON API, from a form that the owner's website renders.
--
-- `source_origin` is the checked `Origin` of a headless submission, and null for the
-- other sources. A headless site shows the consent text itself, so the consent record
-- names that site. Rows from before this migration get `hosted`.

ALTER TABLE signups ADD COLUMN source TEXT NOT NULL DEFAULT 'hosted'
  CHECK (source IN ('hosted', 'embed', 'headless'));
ALTER TABLE signups ADD COLUMN source_origin TEXT;
ALTER TABLE form_consents ADD COLUMN source TEXT NOT NULL DEFAULT 'hosted'
  CHECK (source IN ('hosted', 'embed', 'headless'));
ALTER TABLE form_consents ADD COLUMN source_origin TEXT;
