import type { Database, Row } from "@envelopen/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { contactStatus } from "../contacts/model";
import { type ContactFilters, contactFilterShape, filteredContacts } from "../contacts/query";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { principalKey } from "../principal";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { csvLine } from "./csv";
import { FILE_TTL_MS } from "./model";

// Contact export to CSV (R18). The file goes to R2, and its download link expires after
// 24 hours. Cells that a spreadsheet would run as a formula get a leading quote (csv.ts).
// The export reads 500 contacts per query, so a large workspace costs a few queries.

const PAGE = 500;
export const EXPORT_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "status",
  "consent_basis",
  "consent_source",
  "consent_at",
  "source",
  "tags",
  "lists_subscribed",
  "lists_unsubscribed",
  "unsubscribed_at",
  "created_at",
] as const;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Builds the CSV of the contacts that match the filters. Returns the text and the row count. */
export async function buildContactsCsv(
  db: Kysely<Database>,
  workspaceId: number,
  filters: ContactFilters,
): Promise<{ csv: string; rows: number }> {
  const fields = await db
    .selectFrom("contact_fields")
    .select(["id", "key"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("id")
    .execute();
  const lines = [csvLine([...EXPORT_COLUMNS, ...fields.map((field) => field.key)])];
  let afterId = 0;
  let count = 0;
  for (;;) {
    const page = await filteredContacts(db, workspaceId, filters)
      .select([
        "c.id",
        "c.email",
        "c.first_name",
        "c.last_name",
        "c.consent_basis",
        "c.consent_source",
        "c.consent_at",
        "c.source",
        "c.unsubscribed_at",
        "c.created_at",
        "s.reason as suppression_reason",
        sql<
          string | null
        >`(SELECT group_concat(t.name, '; ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.workspace_id = ${workspaceId} AND ct.contact_id = c.id)`.as(
          "tags",
        ),
        sql<
          string | null
        >`(SELECT group_concat(l.name, '; ') FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.workspace_id = ${workspaceId} AND m.contact_id = c.id AND m.status = 'subscribed')`.as(
          "lists_subscribed",
        ),
        sql<
          string | null
        >`(SELECT group_concat(l.name, '; ') FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.workspace_id = ${workspaceId} AND m.contact_id = c.id AND m.status = 'unsubscribed')`.as(
          "lists_unsubscribed",
        ),
      ])
      .where("c.id", ">", afterId)
      .orderBy("c.id", "asc")
      .limit(PAGE)
      .execute();
    if (page.length === 0) break;
    const ids = page.map((row) => row.id);
    const values =
      fields.length === 0
        ? []
        : await db
            .selectFrom("contact_field_values")
            .select(["contact_id", "field_id", "value"])
            .where("workspace_id", "=", workspaceId)
            .where("contact_id", ">=", ids[0] as number)
            .where("contact_id", "<=", ids.at(-1) as number)
            .execute();
    const fieldValues = new Map(
      values.map((value) => [`${value.contact_id}:${value.field_id}`, value.value]),
    );
    for (const row of page) {
      lines.push(
        csvLine([
          row.email,
          row.first_name,
          row.last_name,
          contactStatus(row),
          row.consent_basis,
          row.consent_source,
          iso(row.consent_at),
          row.source,
          row.tags,
          row.lists_subscribed,
          row.lists_unsubscribed,
          iso(row.unsubscribed_at),
          iso(row.created_at),
          ...fields.map((field) => fieldValues.get(`${row.id}:${field.id}`) ?? null),
        ]),
      );
    }
    count += page.length;
    afterId = ids.at(-1) as number;
    if (page.length < PAGE) break;
  }
  return { csv: lines.join(""), rows: count };
}

export const ExportSchema = z
  .object({
    id: z.number().int(),
    status: z.enum(["ready", "expired"]),
    filename: z.string(),
    filters: z.record(z.string(), z.unknown()),
    rowCount: z.number().int(),
    sizeBytes: z.number().int(),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    downloadUrl: z
      .string()
      .nullable()
      .meta({ description: "Works without a session until `expiresAt`. Null after expiry." }),
  })
  .meta({ id: "Export" });

async function toExport(ctx: OperationContext, row: Row<"exports">) {
  const live = row.status === "ready" && row.file_key !== null && row.expires_at > ctx.now;
  return {
    id: row.id,
    status: live ? ("ready" as const) : ("expired" as const),
    filename: row.filename,
    filters: JSON.parse(row.filters) as Record<string, unknown>,
    rowCount: row.row_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloadUrl:
      live && row.file_key
        ? await requireService(
            ctx.services,
            "signFileLink",
          )({
            key: row.file_key,
            filename: row.filename,
            expiresAt: row.expires_at,
          })
        : null,
  };
}

const EXPORT_MCP = {
  class: "later",
  reason: "Contact export is in the plan's MCP 'later' set.",
} as const;

export const exportsCreate = defineOperation({
  id: "exports.create",
  summary: "Export contacts to CSV",
  description:
    "Writes the contacts that match the filters to a CSV file and returns a download link " +
    "that expires after 24 hours. Cells that start with =, +, -, @, tab, or carriage " +
    "return get a leading quote, so spreadsheets show them as text.",
  method: "post",
  path: "/exports",
  scope: "contacts:export",
  risk: "write",
  mcp: EXPORT_MCP,
  input: z.object(contactFilterShape),
  output: ExportSchema,
  successStatus: 201,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const bucket = requireService(ctx.services, "bucket");
    const { csv, rows } = await buildContactsCsv(db.db, principal.workspaceId, input);
    const size = new TextEncoder().encode(csv).length;
    const date = new Date(now).toISOString().slice(0, 10);
    const filename = `contacts-${date}.csv`;
    const key = `exports/${principal.workspaceId}/${crypto.randomUUID()}.csv`;
    await bucket.put(key, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
    const filters = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined && value !== ""),
    );
    const row = await db.db
      .insertInto("exports")
      .values({
        workspace_id: principal.workspaceId,
        status: "ready",
        file_key: key,
        filename,
        filters: JSON.stringify(filters),
        row_count: rows,
        size_bytes: size,
        created_by: principalKey(principal),
        created_at: now,
        expires_at: now + FILE_TTL_MS,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toExport(ctx, row);
  },
  auditTarget: (_input, output) => ({
    targetType: "export",
    targetId: output.id,
    metadata: { rows: output.rowCount, filters: output.filters },
  }),
});

export const exportsList = defineOperation({
  id: "exports.list",
  summary: "List contact exports",
  description: "Returns exports, newest first, with a download link while the file exists.",
  method: "get",
  path: "/exports",
  scope: "contacts:export",
  risk: "read",
  mcp: EXPORT_MCP,
  input: z.object(pageInputShape),
  output: pageOf(ExportSchema),
  async handler(input, ctx) {
    const { afterId, take } = pageParams(input);
    let query = ctx.db.db
      .selectFrom("exports")
      .selectAll()
      .where("workspace_id", "=", ctx.principal.workspaceId);
    if (afterId !== null) query = query.where("id", "<", afterId);
    const rows = await query.orderBy("id", "desc").limit(take).execute();
    const page = toPage(
      rows,
      input.limit,
      (row) => row.id,
      (row) => row,
    );
    return {
      items: await Promise.all(page.items.map((row) => toExport(ctx, row))),
      nextCursor: page.nextCursor,
    };
  },
});
