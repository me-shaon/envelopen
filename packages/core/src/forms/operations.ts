import type { Database } from "@envelopen/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { normalizeEmail } from "../contacts/email";
import { checkLists } from "../contacts/writes";
import { OperationError } from "../errors";
import { defineOperation } from "../registry/operation";
import {
  CONSENT_TEXT_MAX,
  DEFAULT_CONSENT_TEXT,
  DEFAULT_SUCCESS_MESSAGE,
  FORM_NAME_MAX,
  FormSchema,
  formFieldDefs,
  idList,
  MAX_EMBED_ORIGINS,
  MAX_FORM_FIELDS,
  MAX_FORM_LISTS,
  newPublicId,
  normalizeEmbedOrigin,
  SUCCESS_MESSAGE_MAX,
  toForm,
} from "./model";

// The form operations (U8). Reading forms needs contacts:read, so an agent can find the
// hosted link of a form. Creating, changing, and deleting a form stays with the owner's
// session: the consent text, the lists, and the origins that may embed the form are the
// owner's decisions (plan: forms use session-only scopes).

const Id = z.coerce.number().int().positive();

const FORMS_WRITE_MCP = {
  class: "later",
  reason:
    "Forms change what the public can subscribe to and which sites can embed the form. " +
    "Only the owner session edits them for now. An API scope can come later.",
} as const;

const FormInputShape = {
  name: z.string().trim().min(1).max(FORM_NAME_MAX),
  listIds: z.array(z.number().int().positive()).max(MAX_FORM_LISTS),
  fieldIds: z.array(z.number().int().positive()).max(MAX_FORM_FIELDS),
  consentText: z.string().trim().min(1).max(CONSENT_TEXT_MAX),
  successMessage: z.string().trim().min(1).max(SUCCESS_MESSAGE_MAX),
  allowedOrigins: z.array(z.string().max(200)).max(MAX_EMBED_ORIGINS),
  fromName: z.string().trim().max(100).nullable(),
  fromEmail: z.string().trim().max(320).nullable(),
  enabled: z.boolean(),
};

type FormInput = {
  [K in keyof typeof FormInputShape]: z.output<(typeof FormInputShape)[K]>;
};

async function getRow(db: Kysely<Database>, workspaceId: number, id: number) {
  const row = await db
    .selectFrom("forms")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The form does not exist.");
  return row;
}

/** Checks the values of a create or an update and returns them in their stored form. */
async function cleanInput(db: Kysely<Database>, workspaceId: number, input: FormInput) {
  const listIds = await checkLists(db, workspaceId, input.listIds);
  if (input.enabled && listIds.length === 0) {
    throw new OperationError(
      "invalid_input",
      "Select at least one list before you turn on the form.",
      {
        field: "listIds",
      },
    );
  }
  const fieldIds = [...new Set(input.fieldIds)];
  const defs = await formFieldDefs(db, workspaceId, fieldIds);
  if (defs.length !== fieldIds.length) {
    throw new OperationError("not_found", "A custom field does not exist in this workspace.", {
      field: "fieldIds",
    });
  }
  const origins = [...new Set(input.allowedOrigins.map(normalizeEmbedOrigin))];
  let fromEmail: string | null = null;
  if (input.fromEmail) {
    fromEmail = normalizeEmail(input.fromEmail);
    const domain = fromEmail?.split("@")[1];
    const known = domain
      ? await db
          .selectFrom("sending_domains")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("domain", "=", domain)
          .executeTakeFirst()
      : undefined;
    if (!fromEmail || !known) {
      throw new OperationError(
        "invalid_input",
        "The From address must be on a sending domain of this workspace.",
        { field: "fromEmail" },
      );
    }
  }
  const fromName = input.fromName?.replaceAll(/["<>\r\n]/g, "").trim() || null;
  return {
    name: input.name,
    list_ids: JSON.stringify(listIds),
    field_ids: JSON.stringify(fieldIds),
    consent_text: input.consentText,
    success_message: input.successMessage,
    allowed_origins: JSON.stringify(origins),
    from_name: fromName,
    from_email: fromEmail,
    enabled: input.enabled ? (1 as const) : (0 as const),
    defs,
  };
}

export const formsList = defineOperation({
  id: "forms.list",
  summary: "List signup forms",
  description:
    "Returns the signup forms of the workspace with their hosted link and embed snippet. " +
    "`turnstileConfigured` is false when the deployment has no Turnstile keys: forms then refuse submissions.",
  method: "get",
  path: "/forms",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "A read. An agent can share the hosted link of a form." },
  input: z.object({}),
  output: z
    .object({ items: z.array(FormSchema), turnstileConfigured: z.boolean() })
    .meta({ id: "SignupFormList" }),
  async handler(_input, { principal, db, services }) {
    const rows = await db.db
      .selectFrom("forms")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .orderBy("id", "desc")
      .limit(200)
      .execute();
    const items = [];
    for (const row of rows) {
      const defs = await formFieldDefs(db.db, principal.workspaceId, idList(row.field_ids));
      items.push(toForm(row, defs, services.appOrigin));
    }
    return { items, turnstileConfigured: services.turnstileConfigured === true };
  },
});

export const formsGet = defineOperation({
  id: "forms.get",
  summary: "Get a signup form",
  method: "get",
  path: "/forms/{id}",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "A read. An agent can share the hosted link of a form." },
  input: z.object({ id: Id }),
  output: FormSchema,
  async handler(input, { principal, db, services }) {
    const row = await getRow(db.db, principal.workspaceId, input.id);
    const defs = await formFieldDefs(db.db, principal.workspaceId, idList(row.field_ids));
    return toForm(row, defs, services.appOrigin);
  },
});

export const formsCreate = defineOperation({
  id: "forms.create",
  summary: "Create a signup form",
  description:
    "Creates a hosted and embeddable signup form with double opt-in (R10, R11). A new form " +
    "is off until `enabled` is true.",
  method: "post",
  path: "/forms",
  scope: "workspace:admin",
  risk: "write",
  mcp: FORMS_WRITE_MCP,
  successStatus: 201,
  input: z.object({
    ...FormInputShape,
    listIds: FormInputShape.listIds.default([]),
    fieldIds: FormInputShape.fieldIds.default([]),
    consentText: FormInputShape.consentText.default(DEFAULT_CONSENT_TEXT),
    successMessage: FormInputShape.successMessage.default(DEFAULT_SUCCESS_MESSAGE),
    allowedOrigins: FormInputShape.allowedOrigins.default([]),
    fromName: FormInputShape.fromName.default(null),
    fromEmail: FormInputShape.fromEmail.default(null),
    enabled: FormInputShape.enabled.default(false),
  }),
  output: FormSchema,
  async handler(input, { principal, db, services, now }) {
    const workspaceId = principal.workspaceId;
    const { defs, ...values } = await cleanInput(db.db, workspaceId, input);
    const row = await db.db
      .insertInto("forms")
      .values({
        workspace_id: workspaceId,
        public_id: newPublicId(),
        ...values,
        consent_version: 1,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toForm(row, defs, services.appOrigin);
  },
  auditTarget: (_input, output) => ({ targetType: "form", targetId: output.id }),
});

export const formsUpdate = defineOperation({
  id: "forms.update",
  summary: "Change a signup form",
  description:
    "Replaces the settings of a form. A change of the consent text raises `consentVersion`, " +
    "so each confirmed signup records the text that the subscriber saw.",
  method: "put",
  path: "/forms/{id}",
  scope: "workspace:admin",
  risk: "write",
  mcp: FORMS_WRITE_MCP,
  input: z.object({ id: Id, ...FormInputShape }),
  output: FormSchema,
  async handler(input, { principal, db, services, now }) {
    const workspaceId = principal.workspaceId;
    const current = await getRow(db.db, workspaceId, input.id);
    const { defs, ...values } = await cleanInput(db.db, workspaceId, input);
    const version =
      values.consent_text === current.consent_text
        ? current.consent_version
        : current.consent_version + 1;
    const row = await db.db
      .updateTable("forms")
      .set({ ...values, consent_version: version, updated_at: now })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toForm(row, defs, services.appOrigin);
  },
  auditTarget: (input, output) => ({
    targetType: "form",
    targetId: input.id,
    metadata: { enabled: output.enabled, consentVersion: output.consentVersion },
  }),
});

export const formsDelete = defineOperation({
  id: "forms.delete",
  summary: "Delete a signup form",
  description:
    "Deletes the form and its pending signups. Contacts that confirmed stay, and their " +
    "consent events stay in the history.",
  method: "delete",
  path: "/forms/{id}",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: FORMS_WRITE_MCP,
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    const result = await db.db
      .deleteFrom("forms")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) {
      throw new OperationError("not_found", "The form does not exist.");
    }
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "form", targetId: output.id }),
});
