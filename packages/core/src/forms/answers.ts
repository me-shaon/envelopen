import { FORM_COPY, type FormPageError, fieldInputId } from "@envelopen/email-render/form-page";
import { type FieldDef, type FieldInput, fieldText, storedFieldValue } from "../contacts/fields";
import { FORM_TEXT_MAX } from "./model";

// Answers to custom fields from a public page (U8, U9, R14): the signup form and the
// preference page. Both pages post the raw form values by field key. A choice field
// takes only the ids of its own options, so a forged or foreign id fails. Labels are not
// accepted from a public page.

type AnswerDef = Pick<FieldDef, "id" | "key" | "label" | "type" | "kind" | "options">;

export interface CheckedAnswers {
  /** The values that the subscriber gave, by field key. An empty answer is left out. */
  values: Record<string, FieldInput>;
  errors: FormPageError[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks the answers to `defs`. Other keys in `raw` are ignored. A field in `required`
 * (by field id) must have an answer. A required yes-or-no field must be selected.
 */
export function checkAnswers(
  defs: readonly AnswerDef[],
  raw: Readonly<Record<string, readonly string[]>>,
  required: ReadonlySet<number> = new Set(),
): CheckedAnswers {
  const errors: FormPageError[] = [];
  const values: Record<string, FieldInput> = {};
  for (const def of defs) {
    const target = fieldInputId(def.key);
    const items = (raw[def.key] ?? []).map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) {
      if (required.has(def.id)) {
        const message =
          def.kind !== null
            ? FORM_COPY.requiredChoice(def.label)
            : def.type === "boolean"
              ? FORM_COPY.requiredBox(def.label)
              : FORM_COPY.requiredValue(def.label);
        errors.push({ target, message });
      }
      continue;
    }
    if (def.kind !== null) {
      // Option ids only: a label or a foreign id is refused.
      if (!items.every((item) => /^\d+$/.test(item))) {
        errors.push({ target, message: FORM_COPY.optionInvalid(def.label) });
        continue;
      }
      const ids = items.map(Number);
      try {
        if (def.kind === "choice" && ids.length > 1) throw new Error("one option");
        storedFieldValue(def, def.kind === "choice" ? (ids[0] ?? null) : ids);
        values[def.key] = def.kind === "choice" ? (ids[0] ?? null) : ids;
      } catch {
        errors.push({ target, message: FORM_COPY.optionInvalid(def.label) });
      }
      continue;
    }
    const value = items[0] ?? "";
    if (items.length > 1 || value.length > FORM_TEXT_MAX) {
      errors.push({ target, message: FORM_COPY.textTooLong(def.label) });
    } else if (def.type === "number" && !Number.isFinite(Number(value))) {
      errors.push({ target, message: FORM_COPY.numberInvalid(def.label) });
    } else if (def.type === "date" && !DATE_PATTERN.test(value)) {
      errors.push({ target, message: FORM_COPY.dateInvalid(def.label) });
    } else if (def.type === "boolean") {
      if (value === "true") values[def.key] = "true";
      else if (required.has(def.id)) {
        errors.push({ target, message: FORM_COPY.requiredBox(def.label) });
      } else values[def.key] = "false";
    } else {
      values[def.key] = value;
    }
  }
  return { values, errors };
}

/** A custom field on the preference page, with the contact's stored value. */
export interface PreferenceField extends AnswerDef {
  preference: "read_only" | "editable";
  /** The stored value: text, an option id, or a JSON array of option ids. */
  value: string | null;
}

/** The text of a read-only field on the preference page, or null when it has no value. */
export function preferenceFieldText(field: PreferenceField): string | null {
  if (field.value === null || field.value === "") return null;
  if (field.type === "boolean") return field.value === "true" ? "Yes" : "No";
  return fieldText(field, field.value);
}

/** The raw form values of a stored value, as the page inputs carry them. */
export function rawFieldValue(field: PreferenceField): string[] {
  if (field.value === null) return [];
  if (field.kind === "multi") {
    try {
      const ids: unknown = JSON.parse(field.value);
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch {
      return [];
    }
  }
  return [field.value];
}

export type PreferenceAnswers =
  | { ok: true; changes: Map<number, string | null> }
  | { ok: false; errors: FormPageError[] };

/**
 * The changes of the editable fields that the page showed (`shown`, by key). A field that
 * the owner made editable after the page loaded is not in `shown`, so its value stays. An
 * empty answer clears the value. An unselected yes-or-no box is "false". Only values that
 * differ from the stored ones are changes.
 */
export function preferenceAnswers(
  fields: readonly PreferenceField[],
  raw: Readonly<Record<string, readonly string[]>>,
  shown: ReadonlySet<string>,
): PreferenceAnswers {
  const editable = fields.filter(
    (field) => field.preference === "editable" && shown.has(field.key),
  );
  const checked = checkAnswers(editable, raw);
  if (checked.errors.length > 0) return { ok: false, errors: checked.errors };
  const changes = new Map<number, string | null>();
  for (const field of editable) {
    const answer = checked.values[field.key];
    let next =
      answer === undefined || answer === null
        ? field.type === "boolean"
          ? "false"
          : null
        : storedFieldValue(field, answer);
    const current = field.value === "" ? null : field.value;
    // An unset yes-or-no field that stays unselected is no change.
    if (field.type === "boolean" && next === "false" && current === null) next = null;
    if (next !== current) changes.set(field.id, next);
  }
  return { ok: true, changes };
}
