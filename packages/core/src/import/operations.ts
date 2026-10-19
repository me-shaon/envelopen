import type { Row } from "@envelopen/db";
import { z } from "zod";
import { ConsentBasisSchema } from "../contacts/model";
import { checkLists, cleanTagNames, ensureTags } from "../contacts/writes";
import { OperationError } from "../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { principalKey } from "../principal";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { BOM, detectDelimiter, parseCsv } from "./csv";
import {
  ColumnTargetSchema,
  FILE_TTL_MS,
  ImportSchema,
  MAX_UPLOAD_BYTES,
  suggestMapping,
  toImport,
  validateMapping,
} from "./model";
import { IMPORT_WINDOW_BYTES } from "./process";

// CSV import (R15, R16, F1). The steps are separate calls, so the UI, a script, and
// later an agent use the same flow:
//   1. imports.create uploads the CSV to R2 and returns the header, a sample, and a guess.
//   2. imports.preview stores the mapping, the consent basis, the tags, and the lists, and
//      starts a preview run that counts what the import would do.
//   3. imports.start runs the import. The Workflow deletes the CSV when it ends.
//   4. imports.error_file links to the rows that were not imported.
//
// MCP is "later": an agent needs a signed R2 upload first (plan: MCP classification).

const IMPORT_MCP = {
  class: "later",
  reason: "CSV import needs a signed R2 upload for agents (plan: MCP 'later' set).",
} as const;
const Id = z.coerce.number().int().positive();
const SAMPLE_ROWS = 5;
const MAX_COLUMNS = 100;
/** An import run may wait for a D1 daily-limit reset, so its file lives longer than a day. */
const RUN_TTL_MS = 3 * FILE_TTL_MS;

async function requireImport(ctx: OperationContext, id: number): Promise<Row<"imports">> {
  const row = await ctx.db.db
    .selectFrom("imports")
    .selectAll()
    .where("workspace_id", "=", ctx.principal.workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The import does not exist.");
  return row;
}

export const importsCreate = defineOperation({
  id: "imports.create",
  summary: "Upload a CSV for import",
  description:
    "Stores the CSV in R2 and returns the header, the first rows, and a suggested mapping. " +
    "The file must have a header row. Comma, semicolon, and tab delimiters are detected. " +
    "Nothing is imported until imports.preview and imports.start. The upload is deleted " +
    "after 24 hours when no import starts.",
  method: "post",
  path: "/imports",
  scope: "contacts:write",
  risk: "write",
  mcp: IMPORT_MCP,
  input: z.object({
    filename: z.string().trim().min(1).max(200),
    content: z
      .string()
      .max(MAX_UPLOAD_BYTES)
      .meta({ description: "The CSV text, UTF-8. At most 5 MB." }),
  }),
  output: ImportSchema.extend({
    sample: z.array(z.array(z.string())),
    suggestedMapping: z.array(z.string()),
  }).meta({ id: "ImportUpload" }),
  successStatus: 201,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const bucket = requireService(ctx.services, "bucket");
    const size = new TextEncoder().encode(input.content).length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new OperationError("invalid_input", "The file is larger than 5 MB. Split it.");
    }
    const body = input.content.startsWith(BOM) ? input.content.slice(1) : input.content;
    if (body.trim() === "") throw new OperationError("invalid_input", "The file is empty.");

    const head = body.slice(0, IMPORT_WINDOW_BYTES);
    const delimiter = detectDelimiter(head);
    const { rows } = parseCsv(head, {
      delimiter,
      final: head.length === body.length,
      maxRows: SAMPLE_ROWS + 1,
    });
    const [header] = rows;
    if (!header || header.every((name) => name.trim() === "")) {
      throw new OperationError("invalid_input", "The file has no header row.");
    }
    if (header.length > MAX_COLUMNS) {
      throw new OperationError("invalid_input", `The file has more than ${MAX_COLUMNS} columns.`);
    }
    const headers = header.map((name, index) => name.trim() || `Column ${index + 1}`);
    const sample = rows.slice(1).map((row) => headers.map((_, index) => row[index] ?? ""));

    const key = `imports/${principal.workspaceId}/${crypto.randomUUID()}.csv`;
    await bucket.put(key, input.content, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
    });
    const row = await db.db
      .insertInto("imports")
      .values({
        workspace_id: principal.workspaceId,
        status: "uploaded",
        filename: input.filename,
        file_key: key,
        size_bytes: size,
        headers: JSON.stringify(headers),
        delimiter,
        mapping: null,
        consent_basis: null,
        tag_names: null,
        tag_ids: null,
        list_ids: null,
        preview: null,
        counts: null,
        error_file_key: null,
        failure: null,
        created_by: principalKey(principal),
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
        expires_at: now + FILE_TTL_MS,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toImport(row), sample, suggestedMapping: suggestMapping(headers) };
  },
  auditTarget: (input, output) => ({
    targetType: "import",
    targetId: output.id,
    metadata: { filename: input.filename, sizeBytes: output.sizeBytes },
  }),
});

export const importsList = defineOperation({
  id: "imports.list",
  summary: "List imports",
  description: "Returns the workspace's imports, newest first.",
  method: "get",
  path: "/imports",
  scope: "contacts:read",
  risk: "read",
  mcp: IMPORT_MCP,
  input: z.object(pageInputShape),
  output: pageOf(ImportSchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("imports")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId);
    if (afterId !== null) query = query.where("id", "<", afterId);
    const rows = await query.orderBy("id", "desc").limit(take).execute();
    return toPage(rows, input.limit, (row) => row.id, toImport);
  },
});

export const importsGet = defineOperation({
  id: "imports.get",
  summary: "Get an import",
  description: "Returns the status, the preview counts, and the progress of an import.",
  method: "get",
  path: "/imports/{id}",
  scope: "contacts:read",
  risk: "read",
  mcp: IMPORT_MCP,
  input: z.object({ id: Id }),
  output: ImportSchema,
  async handler(input, ctx) {
    return toImport(await requireImport(ctx, input.id));
  },
});

export const importsPreview = defineOperation({
  id: "imports.preview",
  summary: "Configure an import and preview it",
  description:
    "Stores the column mapping, the consent basis (required), the tags, and the lists, and " +
    "starts a preview run. Poll imports.get until the status is `previewed`. The preview " +
    "counts new and updated contacts, rows skipped as unsubscribed or suppressed, invalid " +
    "rows, and duplicates. Calling it again replaces the configuration and the preview.",
  method: "post",
  path: "/imports/{id}/preview",
  scope: "contacts:write",
  risk: "write",
  mcp: IMPORT_MCP,
  input: z.object({
    id: Id,
    mapping: z.array(ColumnTargetSchema).min(1).max(MAX_COLUMNS).meta({
      description: "One target per column, in column order.",
    }),
    consentBasis: ConsentBasisSchema,
    tags: z.array(z.string()).max(20).optional().meta({
      description: "Tag names for every imported contact. Missing tags are created at start.",
    }),
    listIds: z.array(z.number().int().positive()).max(20).optional(),
  }),
  output: ImportSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const startJob = requireService(ctx.services, "startImportJob");
    const row = await requireImport(ctx, input.id);
    if (!["uploaded", "previewing", "previewed"].includes(row.status) || !row.file_key) {
      throw new OperationError("conflict", `The import is ${row.status}. Upload the file again.`);
    }
    const headers = JSON.parse(row.headers) as string[];
    validateMapping(input.mapping, headers);
    const tags = cleanTagNames(input.tags ?? []);
    const listIds = await checkLists(db.db, principal.workspaceId, input.listIds ?? []);
    const generation = row.preview_generation + 1;
    const result = await db.db
      .updateTable("imports")
      .set({
        mapping: JSON.stringify(input.mapping),
        consent_basis: input.consentBasis,
        tag_names: JSON.stringify(tags),
        list_ids: JSON.stringify(listIds),
        preview_generation: generation,
        status: "previewing",
        preview: null,
        processed_rows: 0,
        cursor_offset: 0,
        error_count: 0,
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", row.id)
      .where("preview_generation", "=", row.preview_generation)
      .where("status", "in", ["uploaded", "previewing", "previewed"])
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new OperationError("conflict", "The import changed. Load it and try again.");
    }
    await startJob({
      workspaceId: principal.workspaceId,
      importId: row.id,
      mode: "preview",
      generation,
    });
    return toImport(await requireImport(ctx, row.id));
  },
  auditTarget: (input, output) => ({
    targetType: "import",
    targetId: output.id,
    metadata: { consentBasis: input.consentBasis },
  }),
});

export const importsStart = defineOperation({
  id: "imports.start",
  summary: "Start an import",
  description:
    "Imports the previewed file with its configuration. Poll imports.get for progress. " +
    "One import runs at a time in a workspace. The uploaded CSV is deleted when the import ends.",
  method: "post",
  path: "/imports/{id}/start",
  scope: "contacts:write",
  risk: "write",
  mcp: IMPORT_MCP,
  input: z.object({ id: Id }),
  output: ImportSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const startJob = requireService(ctx.services, "startImportJob");
    const row = await requireImport(ctx, input.id);
    if (row.status !== "previewed" || !row.file_key) {
      throw new OperationError(
        "conflict",
        row.status === "previewing"
          ? "The preview is still running."
          : `The import is ${row.status}. Run a preview first.`,
      );
    }
    const running = await db.db
      .selectFrom("imports")
      .select("id")
      .where("workspace_id", "=", principal.workspaceId)
      .where("status", "=", "importing")
      .executeTakeFirst();
    if (running) {
      throw new OperationError("conflict", "Another import is running. Wait until it ends.");
    }
    const tagNames = JSON.parse(row.tag_names ?? "[]") as string[];
    const tags = await ensureTags(db.db, principal.workspaceId, tagNames, now);
    const result = await db.db
      .updateTable("imports")
      .set({
        status: "importing",
        tag_ids: JSON.stringify(tags.map((tag) => tag.id)),
        counts: null,
        processed_rows: 0,
        cursor_offset: 0,
        error_count: 0,
        started_at: now,
        updated_at: now,
        expires_at: now + RUN_TTL_MS,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", row.id)
      .where("status", "=", "previewed")
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new OperationError("conflict", "The import changed. Load it and try again.");
    }
    await startJob({
      workspaceId: principal.workspaceId,
      importId: row.id,
      mode: "import",
      generation: row.preview_generation,
    });
    return toImport(await requireImport(ctx, row.id));
  },
  auditTarget: (_input, output) => ({
    targetType: "import",
    targetId: output.id,
    metadata: {
      consentBasis: output.consentBasis,
      tags: output.tags,
      listIds: output.listIds,
      rows: output.preview?.total ?? null,
    },
  }),
});

export const FileLinkSchema = z
  .object({
    url: z
      .string()
      .meta({ description: "Download path. It works without a session until it expires." }),
    expiresAt: z.number().int(),
  })
  .meta({ id: "FileLink" });

export const importsErrorFile = defineOperation({
  id: "imports.error_file",
  summary: "Get the error file of an import",
  description:
    "Returns a download link for the CSV of rows that were not imported, with the row " +
    "number and the reason. The file is deleted 24 hours after the import ends.",
  method: "get",
  path: "/imports/{id}/error-file",
  scope: "contacts:read",
  risk: "read",
  mcp: IMPORT_MCP,
  input: z.object({ id: Id }),
  output: FileLinkSchema,
  async handler(input, ctx) {
    const row = await requireImport(ctx, input.id);
    if (!row.error_file_key || row.expires_at <= ctx.now) {
      throw new OperationError("not_found", "This import has no error file.");
    }
    const base = row.filename.replace(/\.csv$/i, "");
    const url = await requireService(
      ctx.services,
      "signFileLink",
    )({
      key: row.error_file_key,
      filename: `${base}-errors.csv`,
      expiresAt: row.expires_at,
    });
    return { url, expiresAt: row.expires_at };
  },
});
