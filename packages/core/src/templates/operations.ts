import type { Database, DbConnection } from "@envelopen/db";
import { extractLinks, mergeTagNames, sanitizeHtml } from "@envelopen/email-render";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { liveBrand } from "../brand/model";
import { OperationError } from "../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { defineOperation } from "../registry/operation";
import {
  MAX_SOURCE_LENGTH,
  parseBlockContent,
  prepareContent,
  TEMPLATE_FORMATS,
  type TemplateFormat,
} from "./content";
import { contactValues, mergeFields, personalizePreview, testLinkOrigin } from "./preview";

// Templates and saved blocks (R26 to R29, R69). Reads need campaigns:read, the scope of
// drafts and previews. Writes need templates:write. Templates are in the plan's MCP
// "now" set. Deletes are "later", like the other destructive operations.

const Id = z.coerce.number().int().positive();
const Name = z.string().trim().min(1).max(100);
const Subject = z.string().trim().max(200).nullable();
const Preheader = z.string().trim().max(200).nullable();
const Format = z.enum(TEMPLATE_FORMATS).meta({
  id: "TemplateFormat",
  description:
    "`blocks`: editor JSON plus the HTML the editor rendered. `html`: HTML, sanitized on " +
    "save. `markdown`: Markdown, rendered into the email frame and sanitized.",
});

export const TemplateSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    subject: z.string().nullable(),
    format: Format,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "TemplateSummary" });

export const TemplateSchema = TemplateSummarySchema.extend({
  preheader: z.string().nullable(),
  source: z.string().meta({
    description: "Editor JSON, sanitized HTML, or Markdown, as the format says.",
  }),
  html: z.string().meta({ description: "Sanitized HTML that a send personalizes." }),
  text: z.string().meta({ description: "The plain-text part." }),
  editorVersion: z.number().int().nullable(),
  mergeTags: z.array(z.string()).meta({ description: "Merge tag names that the template uses." }),
  links: z
    .array(z.string())
    .meta({ description: "The URLs that click tracking references by index." }),
}).meta({ id: "Template" });

export const SavedBlockSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    content: z.string().meta({ description: "JSON list of editor block nodes." }),
    html: z.string().nullable(),
    editorVersion: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "SavedBlock" });

type TemplateRow = Selectable<Database["templates"]>;

function toSummary(
  row: Pick<TemplateRow, "id" | "name" | "subject" | "format" | "created_at" | "updated_at">,
) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    format: row.format,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTemplate(row: TemplateRow) {
  const html = row.html ?? "";
  return {
    ...toSummary(row),
    preheader: row.preheader,
    source: row.source,
    html,
    text: row.text ?? "",
    editorVersion: row.editor_version,
    mergeTags: mergeTagNames(`${row.subject ?? ""} ${html}`),
    links: extractLinks(html),
  };
}

export async function getTemplateRow(
  db: Kysely<Database>,
  workspaceId: number,
  id: number,
): Promise<TemplateRow> {
  const row = await db
    .selectFrom("templates")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The template does not exist.");
  return row;
}

const contentFields = {
  source: z.string().max(MAX_SOURCE_LENGTH),
  html: z
    .string()
    .max(MAX_SOURCE_LENGTH)
    .optional()
    .meta({ description: "Blocks only: the HTML that the editor rendered from the source." }),
  text: z.string().max(200_000).nullable().optional(),
};

export const templatesList = defineOperation({
  id: "templates.list",
  summary: "List templates",
  description: "Returns the templates of the workspace, newest first.",
  method: "get",
  path: "/templates",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Templates are in the plan's MCP 'now' set." },
  input: z.object(pageInputShape),
  output: pageOf(TemplateSummarySchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("templates")
      .select(["id", "name", "subject", "format", "created_at", "updated_at"])
      .where("workspace_id", "=", principal.workspaceId);
    if (afterId !== null) query = query.where("id", "<", afterId);
    const rows = await query.orderBy("id", "desc").limit(take).execute();
    return toPage(rows, input.limit, (row) => row.id, toSummary);
  },
});

export const templatesMergeFields = defineOperation({
  id: "templates.merge_fields",
  summary: "List merge fields",
  description:
    'The merge tags a template can use, as `{{ key }}` or `{{ key | default: "text" }}`: ' +
    "the standard fields, the custom fields of the workspace, and the unsubscribe and " +
    "preference links.",
  method: "get",
  path: "/templates/merge-fields",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "An agent needs the field names to write a template." },
  input: z.object({}),
  output: z
    .object({
      items: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          kind: z.enum(["standard", "custom", "reserved", "brand"]),
          sample: z.string().nullable(),
        }),
      ),
    })
    .meta({ id: "MergeFieldList" }),
  async handler(_input, { principal, db }) {
    return { items: await mergeFields(db, principal.workspaceId) };
  },
});

export const templatesGet = defineOperation({
  id: "templates.get",
  summary: "Get a template",
  method: "get",
  path: "/templates/{id}",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Templates are in the plan's MCP 'now' set." },
  input: z.object({ id: Id }),
  output: TemplateSchema,
  async handler(input, { principal, db }) {
    return toTemplate(await getTemplateRow(db.db, principal.workspaceId, input.id));
  },
});

export const templatesCreate = defineOperation({
  id: "templates.create",
  summary: "Create a template",
  description:
    "Creates a template from HTML, Markdown, or editor blocks (R69). Envelopen sanitizes " +
    "the HTML before it stores it: no scripts, no event attributes, no `javascript:` URLs.",
  method: "post",
  path: "/templates",
  scope: "templates:write",
  risk: "write",
  mcp: { class: "now", reason: "Templates are in the plan's MCP 'now' set." },
  successStatus: 201,
  input: z.object({
    name: Name,
    subject: Subject.optional(),
    preheader: Preheader.optional(),
    format: Format,
    ...contentFields,
  }),
  output: TemplateSchema,
  async handler(input, { principal, db, now }) {
    const content = await prepareContent(input);
    const row = await db.db
      .insertInto("templates")
      .values({
        workspace_id: principal.workspaceId,
        name: input.name,
        subject: input.subject ?? null,
        preheader: input.preheader ?? null,
        ...content,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(row);
  },
  auditTarget: (_input, output) => ({ targetType: "template", targetId: output.id }),
});

export const templatesUpdate = defineOperation({
  id: "templates.update",
  summary: "Update a template",
  description:
    "Changes the name, subject, preheader, or content. A new source replaces the content " +
    "and is sanitized again. A block template needs `source` and `html` together.",
  method: "patch",
  path: "/templates/{id}",
  scope: "templates:write",
  risk: "write",
  mcp: { class: "now", reason: "Templates are in the plan's MCP 'now' set." },
  input: z.object({
    id: Id,
    name: Name.optional(),
    subject: Subject.optional(),
    preheader: Preheader.optional(),
    format: Format.optional(),
    source: contentFields.source.optional(),
    html: contentFields.html,
    text: contentFields.text,
  }),
  output: TemplateSchema,
  async handler(input, { principal, db, now }) {
    const row = await getTemplateRow(db.db, principal.workspaceId, input.id);
    const format: TemplateFormat = input.format ?? row.format;
    const preheader = input.preheader === undefined ? row.preheader : input.preheader;
    // Markdown puts the preheader into the HTML, so a new preheader renders it again.
    const contentChanged =
      input.source !== undefined ||
      input.html !== undefined ||
      input.format !== undefined ||
      input.text !== undefined ||
      (format === "markdown" && input.preheader !== undefined);
    if (format === "blocks" && (input.source !== undefined) !== (input.html !== undefined)) {
      throw new OperationError(
        "invalid_input",
        "A block template needs `source` and `html` together.",
      );
    }
    const content = contentChanged
      ? await prepareContent({
          format,
          source: input.source ?? row.source,
          html: input.html ?? row.html ?? undefined,
          // A new source gets a new derived text part unless the client sends one.
          text:
            input.text !== undefined ? input.text : input.source === undefined ? row.text : null,
          preheader,
        })
      : {};
    const updated = await db.db
      .updateTable("templates")
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.preheader === undefined ? {} : { preheader: input.preheader }),
        ...content,
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(updated);
  },
  auditTarget: (_input, output) => ({ targetType: "template", targetId: output.id }),
});

export const templatesDuplicate = defineOperation({
  id: "templates.duplicate",
  summary: "Duplicate a template",
  method: "post",
  path: "/templates/{id}/duplicate",
  scope: "templates:write",
  risk: "write",
  mcp: { class: "now", reason: "Templates are in the plan's MCP 'now' set." },
  successStatus: 201,
  input: z.object({ id: Id, name: Name.optional() }),
  output: TemplateSchema,
  async handler(input, { principal, db, now }) {
    const {
      id: _id,
      created_at: _c,
      updated_at: _u,
      ...copy
    } = await getTemplateRow(db.db, principal.workspaceId, input.id);
    const row = await db.db
      .insertInto("templates")
      .values({
        ...copy,
        name: input.name ?? `Copy of ${copy.name}`.slice(0, 100),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(row);
  },
  auditTarget: (input, output) => ({
    targetType: "template",
    targetId: output.id,
    metadata: { duplicateOf: input.id },
  }),
});

export const templatesDelete = defineOperation({
  id: "templates.delete",
  summary: "Delete a template",
  description: "Campaigns keep their own copy of the content, so they are not affected.",
  method: "delete",
  path: "/templates/{id}",
  scope: "templates:write",
  risk: "destructive",
  mcp: { class: "later", reason: "Destructive. Deletes join MCP with the human-approval mode." },
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    await getTemplateRow(db.db, principal.workspaceId, input.id);
    await db.db
      .deleteFrom("templates")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "template", targetId: output.id }),
});

export const templatesPreview = defineOperation({
  id: "templates.preview",
  summary: "Preview a template",
  description:
    "Returns the subject, HTML, and text personalized for one contact, or with sample " +
    "values. A test send of the template uses the same values, so it matches the preview.",
  method: "get",
  path: "/templates/{id}/preview",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Campaign preview is in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({
    id: Id,
    contactId: Id.optional().meta({ description: "Personalize for this contact." }),
  }),
  output: z
    .object({
      subject: z.string(),
      preheader: z.string(),
      html: z.string(),
      text: z.string(),
      missing: z.array(z.string()).meta({
        description: "Merge tags that render empty: no value and no fallback.",
      }),
    })
    .meta({ id: "TemplatePreview" }),
  async handler(input, { principal, db, services }) {
    const row = await getTemplateRow(db.db, principal.workspaceId, input.id);
    const values = await contactValues(db, principal.workspaceId, input.contactId);
    const brand = await liveBrand(db, principal.workspaceId, services.appOrigin);
    return personalizePreview(row, values, testLinkOrigin(services.appOrigin), brand);
  },
});

// Saved blocks --------------------------------------------------------------------------

type SavedBlockRow = Selectable<Database["saved_blocks"]>;

function toSavedBlock(row: SavedBlockRow) {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    html: row.html,
    editorVersion: row.editor_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSavedBlock(db: DbConnection, workspaceId: number, id: number) {
  const row = await db.db
    .selectFrom("saved_blocks")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The saved block does not exist.");
  return row;
}

const blockFields = {
  content: z.string().max(200_000).meta({ description: "JSON list of editor block nodes." }),
  html: z.string().max(200_000).nullable().optional().meta({
    description: "The blocks rendered by the editor, for the preview. Sanitized on save.",
  }),
};

async function cleanBlockHtml(html: string | null | undefined): Promise<string | null> {
  return html ? sanitizeHtml(html) : null;
}

export const savedBlocksList = defineOperation({
  id: "saved_blocks.list",
  summary: "List saved blocks",
  description: "Returns the saved blocks of the workspace, by name (R28).",
  method: "get",
  path: "/saved-blocks",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Saved blocks are part of templates, in the MCP 'now' set." },
  input: z.object({}),
  output: z.object({ items: z.array(SavedBlockSchema) }).meta({ id: "SavedBlockList" }),
  async handler(_input, { principal, db }) {
    const rows = await db.db
      .selectFrom("saved_blocks")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .orderBy("name")
      .orderBy("id")
      .limit(200)
      .execute();
    return { items: rows.map(toSavedBlock) };
  },
});

export const savedBlocksCreate = defineOperation({
  id: "saved_blocks.create",
  summary: "Save a block",
  description: "Saves blocks for reuse in any template of the workspace (R28).",
  method: "post",
  path: "/saved-blocks",
  scope: "templates:write",
  risk: "write",
  mcp: { class: "now", reason: "Saved blocks are part of templates, in the MCP 'now' set." },
  successStatus: 201,
  input: z.object({ name: Name, ...blockFields }),
  output: SavedBlockSchema,
  async handler(input, { principal, db, now }) {
    const count = await db.db
      .selectFrom("saved_blocks")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("workspace_id", "=", principal.workspaceId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= 200) {
      throw new OperationError("conflict", "A workspace can have 200 saved blocks.");
    }
    const row = await db.db
      .insertInto("saved_blocks")
      .values({
        workspace_id: principal.workspaceId,
        name: input.name,
        content: parseBlockContent(input.content),
        html: await cleanBlockHtml(input.html),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSavedBlock(row);
  },
  auditTarget: (_input, output) => ({ targetType: "saved_block", targetId: output.id }),
});

export const savedBlocksUpdate = defineOperation({
  id: "saved_blocks.update",
  summary: "Update a saved block",
  description:
    "Renames a saved block or replaces its content. Templates that used it keep their copy.",
  method: "patch",
  path: "/saved-blocks/{id}",
  scope: "templates:write",
  risk: "write",
  mcp: { class: "now", reason: "Saved blocks are part of templates, in the MCP 'now' set." },
  input: z.object({
    id: Id,
    name: Name.optional(),
    content: blockFields.content.optional(),
    html: blockFields.html,
  }),
  output: SavedBlockSchema,
  async handler(input, { principal, db, now }) {
    await getSavedBlock(db, principal.workspaceId, input.id);
    const row = await db.db
      .updateTable("saved_blocks")
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.content === undefined ? {} : { content: parseBlockContent(input.content) }),
        ...(input.html === undefined ? {} : { html: await cleanBlockHtml(input.html) }),
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSavedBlock(row);
  },
  auditTarget: (_input, output) => ({ targetType: "saved_block", targetId: output.id }),
});

export const savedBlocksDelete = defineOperation({
  id: "saved_blocks.delete",
  summary: "Delete a saved block",
  description: "Templates that used the block keep their copy.",
  method: "delete",
  path: "/saved-blocks/{id}",
  scope: "templates:write",
  risk: "destructive",
  mcp: { class: "later", reason: "Destructive. Deletes join MCP with the human-approval mode." },
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    await getSavedBlock(db, principal.workspaceId, input.id);
    await db.db
      .deleteFrom("saved_blocks")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "saved_block", targetId: output.id }),
});
