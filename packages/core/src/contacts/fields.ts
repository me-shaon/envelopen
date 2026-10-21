import type { ContactFieldKind, Database } from "@envelopen/db";
import { choiceText } from "@envelopen/email-render";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation } from "../registry/operation";
import { inIdList } from "./model";
import { FIELD_KEY_PATTERN } from "./writes";

// Custom fields and their options (R13, KTD5).
//
// `contact_fields.type` keeps its CHECK (text, number, date, boolean). A choice field has
// `kind` 'choice' (one option) or 'multi' (any number of options). The API shows one
// `type` with six values. Values store option ids, so a rename changes only the label:
// a single choice stores `12`, a multiple choice stores `[12,15]` (ids in ascending
// order). Merge tags and exports print the labels in option order, joined with ", ".

export const FIELD_TYPES = ["text", "number", "date", "boolean", "choice", "multi"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const MAX_OPTIONS = 100;
export const OPTION_LABEL_MAX = 100;

export const FieldOptionSchema = z
  .object({
    id: z.number().int(),
    label: z.string(),
    position: z.number().int().meta({ description: "The order of the option, from 0." }),
  })
  .meta({ id: "FieldOption" });

export const ContactFieldSchema = z
  .object({
    id: z.number().int(),
    key: z.string().meta({ description: "The merge tag name, for example `interests`." }),
    label: z.string(),
    type: z.enum(FIELD_TYPES).meta({
      description: "`choice` takes one option. `multi` takes any number of options.",
    }),
    options: z.array(FieldOptionSchema).meta({
      description: "The options of a choice field, in order. Empty for other types.",
    }),
    createdAt: z.number().int(),
  })
  .meta({ id: "ContactField" });

export type ContactField = z.input<typeof ContactFieldSchema>;

export interface FieldDef {
  id: number;
  key: string;
  label: string;
  type: FieldType;
  kind: ContactFieldKind | null;
  options: { id: number; label: string; position: number }[];
  createdAt: number;
}

/** A custom field value in a contact write. See FieldValueSchema. */
export type FieldInput = string | number | ReadonlyArray<string | number> | null;

export const FieldValueSchema = z
  .union([
    z.string().max(1000),
    z.number(),
    z.array(z.union([z.string().max(OPTION_LABEL_MAX), z.number().int()])).max(MAX_OPTIONS),
  ])
  .nullable();

/** The field definitions with their options, by key. Without `keys`, every field. */
export async function loadFieldDefs(
  db: Kysely<Database>,
  workspaceId: number,
  keys?: readonly string[],
): Promise<Map<string, FieldDef>> {
  if (keys && keys.length === 0) return new Map();
  let query = db
    .selectFrom("contact_fields")
    .select(["id", "key", "label", "type", "kind", "created_at"])
    .where("workspace_id", "=", workspaceId);
  // One JSON parameter, so many keys stay within D1's 100 bound parameters.
  if (keys) {
    query = query.where(
      sql<boolean>`key IN (SELECT value FROM json_each(${JSON.stringify([...new Set(keys)])}))`,
    );
  }
  const fields = await query.orderBy("id").execute();
  const choiceFieldIds = fields.filter((field) => field.kind !== null).map((field) => field.id);
  const options =
    choiceFieldIds.length === 0
      ? []
      : await db
          .selectFrom("contact_field_options")
          .select(["id", "field_id", "label", "position"])
          .where("workspace_id", "=", workspaceId)
          .where(inIdList("field_id", choiceFieldIds))
          .orderBy("field_id")
          .orderBy("position")
          .orderBy("id")
          .execute();
  const defs = new Map<string, FieldDef>();
  for (const field of fields) {
    defs.set(field.key, {
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.kind ?? field.type,
      kind: field.kind,
      options: options
        .filter((option) => option.field_id === field.id)
        .map(({ id, label, position }) => ({ id, label, position })),
      createdAt: field.created_at,
    });
  }
  return defs;
}

export function toContactField(def: FieldDef): ContactField {
  return {
    id: def.id,
    key: def.key,
    label: def.label,
    type: def.type,
    options: def.options,
    createdAt: def.createdAt,
  };
}

// Values ------------------------------------------------------------------------------------

function invalid(message: string, field: string): OperationError {
  return new OperationError("invalid_input", message, { field });
}

/**
 * Finds one option. A number is an option id. A text value is an option id when it is
 * digits and the field has that id, otherwise a label, without regard to case. With
 * `labelsOnly` (the import), text is always a label.
 */
function findOption(
  def: Pick<FieldDef, "key" | "options">,
  item: string | number,
  labelsOnly: boolean,
): number {
  if (typeof item === "number") {
    if (!labelsOnly && def.options.some((option) => option.id === item)) return item;
  } else {
    const text = item.trim();
    if (!labelsOnly && /^\d+$/.test(text)) {
      const id = Number(text);
      if (def.options.some((option) => option.id === id)) return id;
    }
    const lower = text.toLowerCase();
    const option = def.options.find((candidate) => candidate.label.toLowerCase() === lower);
    if (option) return option.id;
  }
  throw invalid(`"${String(item)}" is not an option of the field ${def.key}.`, def.key);
}

/**
 * The stored form of a value for a field, or null to clear it. Throws invalid_input for a
 * value that the field does not take, such as an unknown or foreign option id.
 *
 * - Text, number, date, boolean: a text or a number. A list is refused.
 * - `choice`: one option id or label (a list of one is accepted).
 * - `multi`: a list of option ids or labels, or one text with labels separated by commas.
 */
export function storedFieldValue(
  def: Pick<FieldDef, "key" | "kind" | "options">,
  raw: FieldInput,
  options: { labelsOnly?: boolean } = {},
): string | null {
  const labelsOnly = options.labelsOnly ?? false;
  if (raw === null) return null;
  if (def.kind === null) {
    if (Array.isArray(raw)) {
      throw invalid(`The field ${def.key} takes one value, not a list.`, def.key);
    }
    return String(raw);
  }
  let items: Array<string | number>;
  if (Array.isArray(raw)) {
    items = [...raw];
  } else if (typeof raw === "string" && def.kind === "multi") {
    items = raw.split(",");
  } else {
    items = [raw as string | number];
  }
  items = items.filter((item) => typeof item === "number" || item.trim() !== "");
  if (items.length === 0) return null;
  if (def.kind === "choice") {
    if (items.length > 1) {
      throw invalid(`The field ${def.key} takes one option.`, def.key);
    }
    return String(findOption(def, items[0] as string | number, labelsOnly));
  }
  const ids = [...new Set(items.map((item) => findOption(def, item, labelsOnly)))];
  return JSON.stringify(ids.sort((a, b) => a - b));
}

/**
 * The stored values of a contact write, by field key. Fields that do not exist yet are
 * created later as text fields, so their values pass as text. Nothing is written here.
 */
export async function prepareFieldValues(
  db: Kysely<Database>,
  workspaceId: number,
  fields: Readonly<Record<string, FieldInput>> | undefined,
): Promise<Map<string, string | null>> {
  const entries = Object.entries(fields ?? {});
  const values = new Map<string, string | null>();
  if (entries.length === 0) return values;
  for (const [key] of entries) {
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new OperationError(
        "invalid_input",
        `The field key "${key}" is not valid. Use lowercase letters, digits, and underscores.`,
      );
    }
  }
  const defs = await loadFieldDefs(
    db,
    workspaceId,
    entries.map(([key]) => key),
  );
  for (const [key, raw] of entries) {
    const def = defs.get(key) ?? { key, kind: null, options: [] };
    values.set(key, storedFieldValue(def, raw));
  }
  return values;
}

/** The text of a stored value: labels for a choice field, the value as is otherwise. */
export function fieldText(
  def: Pick<FieldDef, "kind" | "options"> | undefined,
  value: string | null,
): string | null {
  return def?.kind ? choiceText(value, def.options) : value;
}

/** Merge values of custom fields, with choice values turned into labels. */
export async function fieldTexts(
  db: Kysely<Database>,
  workspaceId: number,
  values: Readonly<Record<string, string | null>>,
): Promise<Record<string, string | null>> {
  const keys = Object.keys(values);
  const defs = await loadFieldDefs(db, workspaceId, keys);
  return Object.fromEntries(
    keys.map((key) => [key, fieldText(defs.get(key), values[key] ?? null)]),
  );
}

// Options -----------------------------------------------------------------------------------

/** A trimmed option label. Throws for an empty or long label, or one with a comma. */
export function cleanOptionLabel(raw: string): string {
  const label = raw.trim();
  if (label.length === 0 || label.length > OPTION_LABEL_MAX) {
    throw new OperationError(
      "invalid_input",
      `An option label must have 1 to ${OPTION_LABEL_MAX} characters.`,
    );
  }
  // An import and a multiple choice value in text separate labels with commas.
  if (label.includes(",")) {
    throw new OperationError("invalid_input", "An option label cannot contain a comma.");
  }
  return label;
}

function assertLabelFree(def: FieldDef, label: string, exceptId?: number) {
  const lower = label.toLowerCase();
  if (
    def.options.some((option) => option.id !== exceptId && option.label.toLowerCase() === lower)
  ) {
    throw new OperationError("conflict", `The field ${def.key} has an option "${label}".`);
  }
}

async function requireField(db: Kysely<Database>, workspaceId: number, id: number) {
  const row = await db
    .selectFrom("contact_fields")
    .select("key")
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  const def = row ? (await loadFieldDefs(db, workspaceId, [row.key])).get(row.key) : undefined;
  if (!def) throw new OperationError("not_found", "The field does not exist.");
  return def;
}

async function requireChoiceField(db: Kysely<Database>, workspaceId: number, id: number) {
  const def = await requireField(db, workspaceId, id);
  if (def.kind === null) {
    throw new OperationError("invalid_input", `The field ${def.key} is not a choice field.`);
  }
  return def;
}

function requireOption(def: FieldDef, optionId: number) {
  const option = def.options.find((item) => item.id === optionId);
  if (!option) throw new OperationError("not_found", "The option does not exist.");
  return option;
}

/** The contacts whose value of the field holds the option. */
export async function countOptionHolders(
  db: Kysely<Database>,
  workspaceId: number,
  def: Pick<FieldDef, "id" | "kind">,
  optionId: number,
): Promise<number> {
  let query = db
    .selectFrom("contact_field_values as v")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("v.workspace_id", "=", workspaceId)
    .where("v.field_id", "=", def.id);
  query =
    def.kind === "multi"
      ? query.where(
          sql<boolean>`EXISTS (SELECT 1 FROM json_each(v.value) AS j WHERE j.value = ${optionId})`,
        )
      : query.where("v.value", "=", String(optionId));
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.count);
}

// Operations ---------------------------------------------------------------------------------

const Id = z.coerce.number().int().positive();
const FieldLabel = z.string().trim().min(1).max(100);
const OptionLabel = z.string().max(OPTION_LABEL_MAX + 20);

export const fieldsList = defineOperation({
  id: "fields.list",
  summary: "List custom fields",
  description:
    "Returns the custom fields with their types and, for choice fields, the options in " +
    "order. A contact's value of a choice field is an option id. A multiple choice value " +
    "is a JSON array of option ids, for example `[12,15]`.",
  method: "get",
  path: "/fields",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "Agents need the option ids to set choice fields." },
  input: z.object({}),
  output: z.object({ items: z.array(ContactFieldSchema) }),
  async handler(_input, { principal, db }) {
    const defs = await loadFieldDefs(db.db, principal.workspaceId);
    return { items: [...defs.values()].map(toContactField) };
  },
});

export const fieldsCreate = defineOperation({
  id: "fields.create",
  summary: "Create a custom field",
  description:
    "Creates a field. A `choice` field takes one option, and a `multi` field takes any " +
    "number. Give the options of a choice field in order. Option labels are unique in a " +
    "field without regard to case, and cannot contain a comma.",
  method: "post",
  path: "/fields",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Creating a field is reversible setup, like a list or a tag." },
  input: z.object({
    key: z.string().trim().max(40).meta({
      description: "Lowercase letters, digits, and underscores. It is the merge tag name.",
    }),
    label: FieldLabel,
    type: z.enum(FIELD_TYPES),
    options: z.array(OptionLabel).max(MAX_OPTIONS).optional(),
  }),
  output: ContactFieldSchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    if (!FIELD_KEY_PATTERN.test(input.key)) {
      throw new OperationError(
        "invalid_input",
        "The field key is not valid. Use lowercase letters, digits, and underscores.",
      );
    }
    const choice = input.type === "choice" || input.type === "multi";
    const labels = (input.options ?? []).map(cleanOptionLabel);
    if (!choice && labels.length > 0) {
      throw new OperationError("invalid_input", "Only a choice field has options.");
    }
    if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
      throw new OperationError("invalid_input", "Each option label must be different.");
    }
    const existing = await db.db
      .selectFrom("contact_fields")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("key", "=", input.key)
      .executeTakeFirst();
    if (existing) {
      throw new OperationError("conflict", `A field with the key ${input.key} exists.`);
    }
    await db.atomic([
      db.db.insertInto("contact_fields").values({
        workspace_id: workspaceId,
        key: input.key,
        label: input.label,
        type: choice ? "text" : (input.type as "text" | "number" | "date" | "boolean"),
        kind: choice ? (input.type as ContactFieldKind) : null,
        created_at: now,
      }),
      // One JSON parameter carries every label, so 100 options fit D1's parameter limit.
      ...(labels.length === 0
        ? []
        : [
            sql`INSERT INTO contact_field_options (workspace_id, field_id, label, position, created_at)
SELECT f.workspace_id, f.id, j.value, j.key, ${now}
FROM contact_fields AS f, json_each(${JSON.stringify(labels)}) AS j
WHERE f.workspace_id = ${workspaceId} AND f.key = ${input.key}`.compile(db.db),
          ]),
    ]);
    const def = (await loadFieldDefs(db.db, workspaceId, [input.key])).get(input.key);
    if (!def) throw new Error("The new field is missing.");
    return toContactField(def);
  },
  auditTarget: (_input, output) => ({
    targetType: "field",
    targetId: output.id,
    metadata: { key: output.key, type: output.type },
  }),
});

export const fieldsUpdate = defineOperation({
  id: "fields.update",
  summary: "Rename a custom field",
  description: "Changes the label. The key and the type stay.",
  method: "patch",
  path: "/fields/{id}",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "A label change is reversible setup." },
  input: z.object({ id: Id, label: FieldLabel }),
  output: ContactFieldSchema,
  async handler(input, { principal, db }) {
    const def = await requireField(db.db, principal.workspaceId, input.id);
    await db.db
      .updateTable("contact_fields")
      .set({ label: input.label })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", def.id)
      .execute();
    return toContactField({ ...def, label: input.label });
  },
  auditTarget: (_input, output) => ({ targetType: "field", targetId: output.id }),
});

export const fieldsAddOption = defineOperation({
  id: "fields.add_option",
  summary: "Add an option to a choice field",
  description: "Adds the option at the end of the list.",
  method: "post",
  path: "/fields/{id}/options",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Adding an option is reversible setup." },
  input: z.object({ id: Id, label: OptionLabel }),
  output: ContactFieldSchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    const def = await requireChoiceField(db.db, workspaceId, input.id);
    const label = cleanOptionLabel(input.label);
    assertLabelFree(def, label);
    if (def.options.length >= MAX_OPTIONS) {
      throw new OperationError("invalid_input", `A field has at most ${MAX_OPTIONS} options.`);
    }
    const position = Math.max(-1, ...def.options.map((option) => option.position)) + 1;
    await db.db
      .insertInto("contact_field_options")
      .values({ workspace_id: workspaceId, field_id: def.id, label, position, created_at: now })
      .execute();
    return toContactField(await requireField(db.db, workspaceId, def.id));
  },
  auditTarget: (_input, output) => ({ targetType: "field", targetId: output.id }),
});

export const fieldsUpdateOption = defineOperation({
  id: "fields.update_option",
  summary: "Rename an option",
  description:
    "Changes the label of an option. Contacts keep the option, because values store the " +
    "option id. Merge tags and forms show the new label.",
  method: "patch",
  path: "/fields/{id}/options/{optionId}",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "A rename changes no contact value." },
  input: z.object({ id: Id, optionId: Id, label: OptionLabel }),
  output: ContactFieldSchema,
  async handler(input, { principal, db }) {
    const workspaceId = principal.workspaceId;
    const def = await requireChoiceField(db.db, workspaceId, input.id);
    const option = requireOption(def, input.optionId);
    const label = cleanOptionLabel(input.label);
    assertLabelFree(def, label, option.id);
    await db.db
      .updateTable("contact_field_options")
      .set({ label })
      .where("workspace_id", "=", workspaceId)
      .where("field_id", "=", def.id)
      .where("id", "=", option.id)
      .execute();
    return toContactField(await requireField(db.db, workspaceId, def.id));
  },
  auditTarget: (input, output) => ({
    targetType: "field",
    targetId: output.id,
    metadata: { optionId: input.optionId },
  }),
});

export const fieldsReorderOptions = defineOperation({
  id: "fields.reorder_options",
  summary: "Reorder the options of a choice field",
  description: "Sets the order of the options. Give every option id of the field once.",
  method: "put",
  path: "/fields/{id}/options",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "The order changes no contact value." },
  input: z.object({ id: Id, optionIds: z.array(z.number().int().positive()).max(MAX_OPTIONS) }),
  output: ContactFieldSchema,
  async handler(input, { principal, db }) {
    const workspaceId = principal.workspaceId;
    const def = await requireChoiceField(db.db, workspaceId, input.id);
    const known = new Set(def.options.map((option) => option.id));
    if (
      input.optionIds.length !== known.size ||
      new Set(input.optionIds).size !== known.size ||
      input.optionIds.some((id) => !known.has(id))
    ) {
      throw new OperationError("invalid_input", "Give every option id of the field once.");
    }
    if (input.optionIds.length > 0) {
      // The position is the index of the id in the JSON array.
      await db.atomic([
        sql`UPDATE contact_field_options
SET position = (SELECT CAST(j.key AS INTEGER) FROM json_each(${JSON.stringify(input.optionIds)}) AS j WHERE j.value = contact_field_options.id)
WHERE workspace_id = ${workspaceId} AND field_id = ${def.id}`.compile(db.db),
      ]);
    }
    return toContactField(await requireField(db.db, workspaceId, def.id));
  },
  auditTarget: (_input, output) => ({ targetType: "field", targetId: output.id }),
});

export const fieldsDeleteOption = defineOperation({
  id: "fields.delete_option",
  summary: "Delete an option",
  description:
    "Deletes an option that no contact holds. When contacts hold it, the call fails with " +
    "`conflict` and the count of contacts in `details.contacts`, unless `mergeInto` names " +
    "another option of the field. The contacts then get that option, and the delete goes on.",
  method: "delete",
  path: "/fields/{id}/options/{optionId}",
  scope: "lists:write",
  risk: "destructive",
  mcp: { class: "later", reason: "Destructive. Deletes join MCP with the human-approval mode." },
  input: z.object({ id: Id, optionId: Id, mergeInto: Id.optional() }),
  output: ContactFieldSchema.extend({
    merged: z.number().int().meta({ description: "Contacts moved to `mergeInto`." }),
  }),
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    const def = await requireChoiceField(db.db, workspaceId, input.id);
    const option = requireOption(def, input.optionId);
    const holders = await countOptionHolders(db.db, workspaceId, def, option.id);
    const target = input.mergeInto === undefined ? undefined : requireOption(def, input.mergeInto);
    if (target?.id === option.id) {
      throw new OperationError("invalid_input", "Merge the option into another option.");
    }
    if (holders > 0 && !target) {
      throw new OperationError(
        "conflict",
        `${holders} ${holders === 1 ? "contact holds" : "contacts hold"} the option "${option.label}". Merge it into another option to delete it.`,
        { contacts: holders },
      );
    }
    const writes = [];
    if (target && holders > 0) {
      writes.push(
        def.kind === "multi"
          ? // Replace the id in each array, without a duplicate, in ascending order.
            sql`UPDATE contact_field_values
SET value = (
  SELECT json_group_array(id) FROM (
    SELECT DISTINCT CAST(CASE WHEN j.value = ${option.id} THEN ${target.id} ELSE j.value END AS INTEGER) AS id
    FROM json_each(contact_field_values.value) AS j
    ORDER BY id
  )
), updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND field_id = ${def.id}
  AND EXISTS (SELECT 1 FROM json_each(contact_field_values.value) AS j WHERE j.value = ${option.id})`.compile(
              db.db,
            )
          : db.db
              .updateTable("contact_field_values")
              .set({ value: String(target.id), updated_at: now })
              .where("workspace_id", "=", workspaceId)
              .where("field_id", "=", def.id)
              .where("value", "=", String(option.id))
              .compile(),
      );
    }
    writes.push(
      db.db
        .deleteFrom("contact_field_options")
        .where("workspace_id", "=", workspaceId)
        .where("field_id", "=", def.id)
        .where("id", "=", option.id)
        .compile(),
    );
    await db.atomic(writes);
    const after = await requireField(db.db, workspaceId, def.id);
    return { ...toContactField(after), merged: target ? holders : 0 };
  },
  auditTarget: (input, output) => ({
    targetType: "field",
    targetId: output.id,
    metadata: { optionId: input.optionId, mergeInto: input.mergeInto ?? null },
  }),
});
