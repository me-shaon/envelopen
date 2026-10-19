import type { ConsentBasis, Row } from "@envelopen/db";
import { z } from "zod";
import { CONSENT_BASES } from "../contacts/model";
import { OperationError } from "../errors";

// The import model (R15, R16). The flow: upload, column mapping, consent basis and
// tags, a preview run with counts, the import run, and an error file.

/** Files that hold contact data (the upload, the error file, exports) expire after 24 hours. */
export const FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Upload limit. JSON parsing of a larger body risks the 10 ms CPU limit on Workers Free. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const COLUMN_TARGETS = ["email", "first_name", "last_name", "ignore"] as const;
const FIELD_TARGET = /^field:[a-z][a-z0-9_]{0,39}$/;

export const ColumnTargetSchema = z
  .string()
  .refine(
    (value) => (COLUMN_TARGETS as readonly string[]).includes(value) || FIELD_TARGET.test(value),
    "Use email, first_name, last_name, ignore, or field:<key>.",
  )
  .meta({
    description:
      "Where a column goes: `email`, `first_name`, `last_name`, `ignore`, or `field:<key>` for a custom field.",
  });

// Zod-to-OpenAPI turns `.nullable()` on a schema with an id into a nullable component, so
// nullable uses take the shape without the id.
const ImportCountsShape = z.object({
  total: z.number().int().meta({ description: "Data rows read." }),
  new: z.number().int(),
  updated: z.number().int(),
  skippedUnsubscribed: z.number().int(),
  skippedSuppressed: z.number().int(),
  invalid: z.number().int(),
  duplicate: z
    .number()
    .int()
    .meta({ description: "Later rows with an address seen earlier in the file." }),
});

export const ImportCountsSchema = ImportCountsShape.meta({ id: "ImportCounts" });

export type ImportCounts = z.infer<typeof ImportCountsSchema>;

export function emptyCounts(): ImportCounts {
  return {
    total: 0,
    new: 0,
    updated: 0,
    skippedUnsubscribed: 0,
    skippedSuppressed: 0,
    invalid: 0,
    duplicate: 0,
  };
}

export function addCounts(a: ImportCounts, b: ImportCounts): ImportCounts {
  return {
    total: a.total + b.total,
    new: a.new + b.new,
    updated: a.updated + b.updated,
    skippedUnsubscribed: a.skippedUnsubscribed + b.skippedUnsubscribed,
    skippedSuppressed: a.skippedSuppressed + b.skippedSuppressed,
    invalid: a.invalid + b.invalid,
    duplicate: a.duplicate + b.duplicate,
  };
}

export const IMPORT_STATUSES = [
  "uploaded",
  "previewing",
  "previewed",
  "importing",
  "completed",
  "failed",
  "expired",
] as const;

export const ImportSchema = z
  .object({
    id: z.number().int(),
    status: z.enum(IMPORT_STATUSES),
    filename: z.string(),
    sizeBytes: z.number().int(),
    headers: z.array(z.string()),
    delimiter: z.string(),
    mapping: z.array(z.string()).nullable(),
    consentBasis: z.enum(CONSENT_BASES).nullable(),
    tags: z.array(z.string()),
    listIds: z.array(z.number().int()),
    preview: ImportCountsShape.nullable(),
    counts: ImportCountsShape.nullable().meta({ description: "Counts of the import run so far." }),
    processedRows: z.number().int(),
    rowsWritten: z.number().int().meta({ description: "D1 rows written by the import run." }),
    estimatedRowWrites: z.number().int().nullable().meta({
      description:
        "Estimate of the D1 rows that the import writes, from the preview. Workers Free allows 100,000 per day.",
    }),
    errorCount: z.number().int(),
    hasErrorFile: z.boolean(),
    failure: z.string().nullable(),
    createdAt: z.number().int(),
    startedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
    expiresAt: z.number().int().meta({
      description: "The upload, or the error file after the import, is deleted at this time.",
    }),
  })
  .meta({ id: "Import" });

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// D1 rows written per contact. Each table row also writes its index entries. The import
// test measures a new contact with one tag (9 rows). The list and field values count
// the table row and every index of their tables.
const WRITES_PER_NEW_CONTACT = 6;
const WRITES_PER_UPDATED_CONTACT = 1;
const WRITES_PER_TAG = 3;
const WRITES_PER_LIST = 4;
const WRITES_PER_FIELD = 3;

/** An upper estimate of the D1 rows that an import writes. */
export function estimateRowWrites(
  counts: ImportCounts,
  extras: { tags: number; lists: number; fields: number },
): number {
  const perContact =
    extras.tags * WRITES_PER_TAG +
    extras.lists * WRITES_PER_LIST +
    extras.fields * WRITES_PER_FIELD;
  const chunks = Math.ceil(counts.total / 100);
  return (
    counts.new * (WRITES_PER_NEW_CONTACT + perContact) +
    counts.updated * (WRITES_PER_UPDATED_CONTACT + perContact) +
    chunks
  );
}

export function parseCounts(text: string | null): ImportCounts | null {
  return text === null ? null : { ...emptyCounts(), ...parseJson<Partial<ImportCounts>>(text, {}) };
}

export function toImport(row: Row<"imports">): z.input<typeof ImportSchema> {
  const mapping = parseJson<string[] | null>(row.mapping, null);
  const tags = parseJson<string[]>(row.tag_names, []);
  const listIds = parseJson<number[]>(row.list_ids, []);
  const preview = parseCounts(row.preview);
  return {
    id: row.id,
    status: row.status,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    headers: parseJson<string[]>(row.headers, []),
    delimiter: row.delimiter,
    mapping,
    consentBasis: row.consent_basis,
    tags,
    listIds,
    preview,
    counts: parseCounts(row.counts),
    processedRows: row.processed_rows,
    rowsWritten: row.rows_written,
    estimatedRowWrites:
      preview && row.status !== "previewing"
        ? estimateRowWrites(preview, {
            tags: tags.length,
            lists: listIds.length,
            fields: (mapping ?? []).filter((target) => target.startsWith("field:")).length,
          })
        : null,
    errorCount: row.error_count,
    hasErrorFile: row.error_file_key !== null,
    failure: row.failure,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

export interface ImportConfig {
  mapping: string[];
  consentBasis: ConsentBasis;
  tagIds: number[];
  listIds: number[];
}

/** Reads the run configuration of an import row. Throws when the preview request has not set it. */
export function importConfig(row: Row<"imports">): ImportConfig {
  const mapping = parseJson<string[] | null>(row.mapping, null);
  if (!mapping || !row.consent_basis || !CONSENT_BASES.includes(row.consent_basis)) {
    throw new Error(`Import ${row.id} has no mapping or consent basis.`);
  }
  return {
    mapping,
    consentBasis: row.consent_basis,
    tagIds: parseJson<number[]>(row.tag_ids, []),
    listIds: parseJson<number[]>(row.list_ids, []),
  };
}

/** Checks a mapping against the header: one target per column and exactly one email column. */
export function validateMapping(mapping: readonly string[], headers: readonly string[]): void {
  if (mapping.length !== headers.length) {
    throw new OperationError(
      "invalid_input",
      `The mapping has ${mapping.length} columns, and the file has ${headers.length}.`,
    );
  }
  const count = (target: string) => mapping.filter((item) => item === target).length;
  if (count("email") !== 1) {
    throw new OperationError("invalid_input", "Map exactly one column to the email address.");
  }
  for (const target of ["first_name", "last_name"]) {
    if (count(target) > 1) {
      throw new OperationError("invalid_input", `Map at most one column to ${target}.`);
    }
  }
  const fields = mapping.filter((target) => target.startsWith("field:"));
  if (new Set(fields).size !== fields.length) {
    throw new OperationError("invalid_input", "Map each custom field from one column only.");
  }
}

const HEADER_TARGETS: ReadonlyArray<[RegExp, string]> = [
  [/^(e-?mail|e-?mail address|email_address|emailaddress)$/, "email"],
  [/^(first[ _-]?name|given[ _-]?name|forename|first)$/, "first_name"],
  [/^(last[ _-]?name|surname|family[ _-]?name|last)$/, "last_name"],
];

/** A mapping guess from the header names. Unknown columns are ignored. */
export function suggestMapping(headers: readonly string[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const name = header.trim().toLowerCase();
    for (const [pattern, target] of HEADER_TARGETS) {
      if (pattern.test(name) && !used.has(target)) {
        used.add(target);
        return target;
      }
    }
    return "ignore";
  });
}
