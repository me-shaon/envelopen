import { type DbConnection, isD1DailyLimitError, nextUtcMidnight, type Row } from "@envelopen/db";
import { normalizeEmail } from "../contacts/email";
import {
  changeConsent,
  chunk,
  EMAILS_PER_QUERY,
  ensureFields,
  fillEmailHashes,
  firstConsentEvents,
  insertContacts,
  setFieldValues,
  subscribeContacts,
  tagContacts,
  updateNames,
} from "../contacts/writes";
import type { ImportJob, Services } from "../services";
import { csvLine, parseCsv } from "./csv";
import {
  addCounts,
  emptyCounts,
  FILE_TTL_MS,
  type ImportCounts,
  importConfig,
  parseCounts,
} from "./model";

// One import run reads the CSV from R2 in chunks. The import Workflow
// (apps/worker/src/workflows/import-workflow.ts) runs each chunk as one step.
//
// Free-plan budget per chunk (KTD20, KTD24): 100 rows, at most 64 KB of the file, about
// 25 D1 queries in one atomic batch, and one HMAC per row. That fits 10 ms CPU and 50
// queries per step. A step limit of 1,024 per Workflow allows 1,000 chunks per run.
//
// Each chunk commits its writes and its progress in one D1 batch. The progress row
// records the byte offset of the next chunk, so a retried step that already committed
// does not write again: it only reads the chunk to find where the next one starts.

export const IMPORT_CHUNK_ROWS = 100;
export const IMPORT_WINDOW_BYTES = 64 * 1024;
export const IMPORT_MAX_CHUNKS = 1_000;
/** Wait a little past 00:00 UTC before the run tries D1 again. */
const DAILY_LIMIT_MARGIN_MS = 5 * 60 * 1000;
/** Characters of a duplicate-check key: a prefix of the address hash. 64 bits is plenty. */
const SEEN_KEY_LENGTH = 16;

export interface ImportDeps {
  db: DbConnection;
  services: Pick<Services, "bucket" | "hashEmail">;
}

export type ChunkOutcome =
  | {
      kind: "chunk";
      nextOffset: number;
      done: boolean;
      /** Duplicate-check keys of the valid addresses in this chunk. */
      seen: string[];
      rowsWritten: number;
    }
  /** D1 rejected a query for the daily Free-plan limit. Try the same chunk after the reset. */
  | { kind: "paused"; resumeAt: number }
  /** The import changed (a new preview, or it ended). This run stops without writing. */
  | { kind: "stale" };

/** A failure that a retry cannot fix, such as a row longer than the read window. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export function importSource(id: number): string {
  return `import:${id}`;
}

export function errorPartPrefix(workspaceId: number, importId: number): string {
  return `imports/${workspaceId}/${importId}/errors/`;
}

export function errorFileKey(workspaceId: number, importId: number): string {
  return `imports/${workspaceId}/${importId}/errors.csv`;
}

export const ERROR_FILE_HEADER = csvLine(["row", "email", "reason"]);

async function loadImport(db: DbConnection, job: ImportJob): Promise<Row<"imports"> | undefined> {
  return db.db
    .selectFrom("imports")
    .selectAll()
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", job.importId)
    .executeTakeFirst();
}

/** True while this run is the current run of the import. */
function isCurrent(row: Row<"imports">, job: ImportJob): boolean {
  if (job.mode === "preview") {
    return row.status === "previewing" && row.preview_generation === job.generation;
  }
  return row.status === "importing" && row.preview_generation === job.generation;
}

function cell(cells: readonly string[], index: number): string | null {
  if (index < 0) return null;
  const value = (cells[index] ?? "").trim();
  return value === "" ? null : value.slice(0, 1000);
}

function name(cells: readonly string[], index: number): string | null {
  return cell(cells, index)?.slice(0, 100) ?? null;
}

interface ValidRow {
  line: number;
  email: string;
  emailHash: string;
  firstName: string | null;
  lastName: string | null;
  fields: Map<string, string | null>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Reads and, when this run owns the next chunk, commits one chunk of the import. */
export async function processImportChunk(
  deps: ImportDeps,
  job: ImportJob,
  offset: number,
  seen: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<ChunkOutcome> {
  try {
    return await runChunk(deps, job, offset, seen, now);
  } catch (error) {
    if (isD1DailyLimitError(error)) {
      return { kind: "paused", resumeAt: nextUtcMidnight(now) + DAILY_LIMIT_MARGIN_MS };
    }
    throw error;
  }
}

async function runChunk(
  deps: ImportDeps,
  job: ImportJob,
  offset: number,
  seen: ReadonlySet<string>,
  now: number,
): Promise<ChunkOutcome> {
  const { db } = deps;
  const workspaceId = job.workspaceId;
  const row = await loadImport(db, job);
  if (!row || !isCurrent(row, job)) return { kind: "stale" };
  if (!row.file_key) throw new ImportFileError("The uploaded file is gone.");
  const config = importConfig(row);
  // The progress row is past this offset when an earlier try of this step committed.
  const commit = row.cursor_offset === offset;
  const writtenBefore = db.meter.rowsWritten;

  const object = await deps.services.bucket.get(row.file_key, {
    range: { offset, length: IMPORT_WINDOW_BYTES },
  });
  if (!object) throw new ImportFileError("The uploaded file is gone.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const bom = offset === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const text = decoder.decode(bytes.subarray(bom));
  const final = offset + bytes.length >= row.size_bytes;
  const first = offset === 0;
  const parsed = parseCsv(text, {
    delimiter: row.delimiter,
    final,
    maxRows: IMPORT_CHUNK_ROWS + (first ? 1 : 0),
  });
  if (parsed.consumed === 0 && !final) {
    throw new ImportFileError(`A row is longer than ${IMPORT_WINDOW_BYTES / 1024} KB.`);
  }
  const nextOffset = offset + bom + encoder.encode(text.slice(0, parsed.consumed)).length;
  const done = final && parsed.consumed >= text.length;
  const dataRows = first ? parsed.rows.slice(1) : parsed.rows;

  // Classify the rows -----------------------------------------------------------------
  const emailIndex = config.mapping.indexOf("email");
  const firstIndex = config.mapping.indexOf("first_name");
  const lastIndex = config.mapping.indexOf("last_name");
  const fieldColumns = config.mapping.flatMap((target, index) =>
    target.startsWith("field:") ? [{ key: target.slice("field:".length), index }] : [],
  );

  const counts: ImportCounts = { ...emptyCounts(), total: dataRows.length };
  const errors: Array<[number, string]> = [];
  const valid: ValidRow[] = [];
  const chunkSeen = new Set<string>();
  const base = row.processed_rows;
  for (const [i, cells] of dataRows.entries()) {
    const line = base + i + 1;
    const raw = cell(cells, emailIndex);
    const email = raw === null ? null : normalizeEmail(raw);
    if (email === null) {
      counts.invalid += 1;
      const reason = raw === null ? "No email address" : "Not a valid email address";
      errors.push([line, csvLine([line, raw, reason])]);
      continue;
    }
    const hash = await deps.services.hashEmail(email);
    const key = hash.slice(0, SEEN_KEY_LENGTH);
    if (seen.has(key) || chunkSeen.has(key)) {
      counts.duplicate += 1;
      errors.push([line, csvLine([line, raw, "Duplicate of an earlier row"])]);
      continue;
    }
    chunkSeen.add(key);
    valid.push({
      line,
      email,
      emailHash: hash,
      firstName: name(cells, firstIndex),
      lastName: name(cells, lastIndex),
      fields: new Map(fieldColumns.map(({ key: field, index }) => [field, cell(cells, index)])),
    });
  }

  const result = (rowsWritten: number): ChunkOutcome => ({
    kind: "chunk",
    nextOffset,
    done,
    seen: [...chunkSeen],
    rowsWritten,
  });
  if (!commit) return result(0);

  // Read the current state of these addresses ----------------------------------------
  const existing = new Map<
    string,
    { id: number; unsubscribed_at: number | null; consent_basis: string; email_hash: string | null }
  >();
  const suppressed = new Set<string>();
  for (const part of chunk(valid, EMAILS_PER_QUERY)) {
    const [contacts, suppressions] = await Promise.all([
      db.db
        .selectFrom("contacts")
        .select(["id", "email", "unsubscribed_at", "consent_basis", "email_hash"])
        .where("workspace_id", "=", workspaceId)
        .where(
          "email",
          "in",
          part.map((item) => item.email),
        )
        .execute(),
      db.db
        .selectFrom("suppressions")
        .select("email_hash")
        .where("workspace_id", "=", workspaceId)
        .where(
          "email_hash",
          "in",
          part.map((item) => item.emailHash),
        )
        .execute(),
    ]);
    for (const contact of contacts) existing.set(contact.email, contact);
    for (const suppression of suppressions) suppressed.add(suppression.email_hash);
  }

  const created: ValidRow[] = [];
  const updated: ValidRow[] = [];
  for (const item of valid) {
    const contact = existing.get(item.email);
    if (suppressed.has(item.emailHash)) {
      counts.skippedSuppressed += 1;
      errors.push([item.line, csvLine([item.line, item.email, "Suppressed"])]);
    } else if (contact?.unsubscribed_at != null) {
      counts.skippedUnsubscribed += 1;
      errors.push([item.line, csvLine([item.line, item.email, "Unsubscribed"])]);
    } else if (contact) {
      counts.updated += 1;
      updated.push(item);
    } else {
      counts.new += 1;
      created.push(item);
    }
  }

  // Write -------------------------------------------------------------------------------
  const writes = [];
  if (job.mode === "import") {
    if (errors.length > 0) {
      // Keyed by offset, so a retry overwrites the same part.
      await deps.services.bucket.put(
        `${errorPartPrefix(workspaceId, job.importId)}${String(offset).padStart(12, "0")}.csv`,
        errors
          .sort(([a], [b]) => a - b)
          .map(([, line]) => line)
          .join(""),
      );
    }
    const source = importSource(job.importId);
    const [actorType = "user", actorId = ""] = splitActor(row.created_by);
    const accepted = [...created, ...updated].map((item) => item.email);
    writes.push(
      ...insertContacts(db.db, workspaceId, created, {
        consentBasis: config.consentBasis,
        consentSource: source,
        source,
        now,
      }),
      ...firstConsentEvents(
        db.db,
        workspaceId,
        created.map((item) => item.email),
        { source, actorType, actorId, note: row.filename, now },
      ),
      ...updateNames(db.db, workspaceId, updated, now),
      ...fillEmailHashes(
        db.db,
        workspaceId,
        updated.filter((item) => existing.get(item.email)?.email_hash === null),
      ),
    );
    // The owner may raise a basis of unknown with an import. An API key may not (R73).
    if (actorType === "user" && config.consentBasis !== "unknown") {
      const unknownIds = updated.flatMap((item) => {
        const contact = existing.get(item.email);
        return contact?.consent_basis === "unknown" ? [contact.id] : [];
      });
      writes.push(
        ...changeConsent(db.db, workspaceId, unknownIds, {
          from: "unknown",
          to: config.consentBasis,
          source,
          actorType,
          actorId,
          note: row.filename,
          now,
        }),
      );
    }
    writes.push(
      ...tagContacts(db.db, workspaceId, accepted, config.tagIds, now),
      ...subscribeContacts(db.db, workspaceId, accepted, config.listIds, { source, now }),
    );
    if (fieldColumns.length > 0 && accepted.length > 0) {
      const fieldIds = await ensureFields(
        db.db,
        workspaceId,
        fieldColumns.map((column) => column.key),
      );
      for (const { key } of fieldColumns) {
        const fieldId = fieldIds.get(key);
        if (fieldId === undefined) continue;
        const values = [...created, ...updated].flatMap((item) => {
          const value = item.fields.get(key) ?? null;
          // A blank cell keeps the stored value.
          return value === null ? [] : [{ email: item.email, value }];
        });
        writes.push(...setFieldValues(db.db, workspaceId, fieldId, values, now));
      }
    }
  }

  const progress = db.db
    .updateTable("imports")
    .set((eb) => ({
      ...(job.mode === "import"
        ? { counts: JSON.stringify(addCounts(parseCounts(row.counts) ?? emptyCounts(), counts)) }
        : {
            preview: JSON.stringify(addCounts(parseCounts(row.preview) ?? emptyCounts(), counts)),
          }),
      processed_rows: eb("processed_rows", "+", dataRows.length),
      cursor_offset: nextOffset,
      error_count: eb("error_count", "+", job.mode === "import" ? errors.length : 0),
      updated_at: now,
    }))
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", job.importId)
    .where("status", "=", job.mode === "import" ? "importing" : "previewing")
    .where("preview_generation", "=", job.generation)
    .where("cursor_offset", "=", offset);
  await db.atomic([...writes, progress]);
  return result(db.meter.rowsWritten - writtenBefore);
}

function splitActor(createdBy: string): [string, string] {
  const at = createdBy.indexOf(":");
  return at < 0 ? ["user", createdBy] : [createdBy.slice(0, at), createdBy.slice(at + 1)];
}

async function deleteErrorParts(deps: ImportDeps, workspaceId: number, importId: number) {
  const prefix = errorPartPrefix(workspaceId, importId);
  let cursor: string | undefined;
  do {
    const listed = await deps.services.bucket.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await deps.services.bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Joins the error parts into one file and returns its key, or null when there were no errors. */
async function buildErrorFile(
  deps: ImportDeps,
  workspaceId: number,
  importId: number,
): Promise<string | null> {
  const prefix = errorPartPrefix(workspaceId, importId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await deps.services.bucket.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  if (keys.length === 0) return null;
  // Zero-padded offsets sort in file order.
  keys.sort();
  const parts = [ERROR_FILE_HEADER];
  for (const key of keys) {
    const object = await deps.services.bucket.get(key);
    if (object) parts.push(await object.text());
  }
  const key = errorFileKey(workspaceId, importId);
  await deps.services.bucket.put(key, parts.join(""), {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
  });
  await deleteErrorParts(deps, workspaceId, importId);
  return key;
}

/**
 * Ends a run. A preview run marks the import previewed. An import run writes the error
 * file, deletes the uploaded CSV, and marks the import completed.
 */
export async function finishImport(
  deps: ImportDeps,
  job: ImportJob,
  totals: { rowsWritten: number },
  now: number = Date.now(),
): Promise<void> {
  const { db } = deps;
  const row = await loadImport(db, job);
  if (!row || !isCurrent(row, job)) return;
  if (job.mode === "preview") {
    await db.db
      .updateTable("imports")
      .set({ status: "previewed", updated_at: now })
      .where("workspace_id", "=", job.workspaceId)
      .where("id", "=", job.importId)
      .where("status", "=", "previewing")
      .where("preview_generation", "=", job.generation)
      .execute();
    return;
  }
  const errorKey = await buildErrorFile(deps, job.workspaceId, job.importId);
  if (row.file_key) await deps.services.bucket.delete(row.file_key);
  await db.db
    .updateTable("imports")
    .set({
      status: "completed",
      file_key: null,
      error_file_key: errorKey,
      rows_written: totals.rowsWritten,
      completed_at: now,
      updated_at: now,
      expires_at: now + FILE_TTL_MS,
    })
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", job.importId)
    .where("status", "=", "importing")
    .execute();
}

/** Marks the current run failed and deletes the uploaded file and any error parts. */
export async function failImport(
  deps: ImportDeps,
  job: ImportJob,
  message: string,
  now: number = Date.now(),
): Promise<void> {
  const { db } = deps;
  const row = await loadImport(db, job);
  if (!row || !isCurrent(row, job)) return;
  if (row.file_key) await deps.services.bucket.delete(row.file_key);
  await deleteErrorParts(deps, job.workspaceId, job.importId);
  await db.db
    .updateTable("imports")
    .set({
      status: "failed",
      failure: message.slice(0, 500),
      file_key: null,
      updated_at: now,
      completed_at: now,
    })
    .where("workspace_id", "=", job.workspaceId)
    .where("id", "=", job.importId)
    .where("status", "=", job.mode === "import" ? "importing" : "previewing")
    .execute();
}

/**
 * Runs a whole import run in this invocation, chunk by chunk, as the Workflow does in
 * steps. Tests and tools use it. Returns the number of chunks.
 */
export async function runImportJob(deps: ImportDeps, job: ImportJob): Promise<number> {
  const seen = new Set<string>();
  let offset = 0;
  let rowsWritten = 0;
  for (let chunks = 1; chunks <= IMPORT_MAX_CHUNKS; chunks++) {
    const outcome = await processImportChunk(deps, job, offset, seen);
    if (outcome.kind === "stale") return chunks;
    if (outcome.kind === "paused") throw new Error("D1 daily limit reached.");
    for (const key of outcome.seen) seen.add(key);
    rowsWritten += outcome.rowsWritten;
    offset = outcome.nextOffset;
    if (outcome.done) {
      await finishImport(deps, job, { rowsWritten });
      return chunks;
    }
  }
  await failImport(deps, job, "The file has too many rows for one import. Split it.");
  return IMPORT_MAX_CHUNKS;
}
