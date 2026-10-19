import { env } from "cloudflare:workers";
import { createDb, type DbConnection } from "@envelopen/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  type TestServices,
  testServices,
} from "../../test/fixtures";
import { contactsGet, contactsList, contactsUpdate, contactsUpsert } from "../contacts/operations";
import { runOperation } from "../executor";
import { listsCreate } from "../lists/operations";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import type { ImportJob } from "../services";
import { suppressionsAdd } from "../suppression/operations";
import { csvLine } from "./csv";
import type { ImportCounts } from "./model";
import {
  importsCreate,
  importsErrorFile,
  importsGet,
  importsPreview,
  importsStart,
} from "./operations";
import {
  finishImport,
  IMPORT_CHUNK_ROWS,
  type ImportDeps,
  processImportChunk,
  runImportJob,
} from "./process";

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

/** A D1 binding that counts statements, to check the per-step query budget. */
function countingD1(inner: D1Database) {
  const counter = { count: 0 };
  const binding = {
    prepare(query: string) {
      counter.count += 1;
      return inner.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => inner.batch(statements),
    exec: (query: string) => inner.exec(query),
    withSession: (bookmark?: string) => inner.withSession(bookmark),
    dump: () => inner.dump(),
  } as unknown as D1Database;
  return { binding, counter };
}

const counting = countingD1(env.DB);

function connect(): DbConnection {
  return createDb({ DB: counting.binding }, { enforceWorkspaceScope: true });
}

async function owner(name = "Import") {
  const conn = connect();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, name);
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

function run<O>(
  conn: DbConnection,
  principal: Principal,
  operation: Parameters<typeof runOperation>[1],
  input: unknown,
) {
  return runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
}

function deps(conn: DbConnection): ImportDeps {
  return { db: conn, services };
}

interface ImportView {
  id: number;
  status: string;
  preview: ImportCounts | null;
  counts: ImportCounts | null;
  processedRows: number;
  rowsWritten: number;
  estimatedRowWrites: number | null;
  errorCount: number;
  hasErrorFile: boolean;
  headers: string[];
  delimiter: string;
}

interface Config {
  mapping: string[];
  consentBasis: string;
  tags?: string[];
  listIds?: number[];
}

/** Upload, preview, and start, with each Workflow run done in this invocation. */
async function importCsv(
  conn: DbConnection,
  principal: Principal,
  content: string,
  config: Config,
): Promise<{
  upload: ImportView & { sample: string[][] };
  previewed: ImportView;
  done: ImportView;
}> {
  const upload = await run<ImportView & { sample: string[][] }>(conn, principal, importsCreate, {
    filename: "students.csv",
    content,
  });
  await run(conn, principal, importsPreview, { id: upload.id, ...config });
  await runImportJob(deps(conn), services.jobs.at(-1) as ImportJob);
  const previewed = await run<ImportView>(conn, principal, importsGet, { id: upload.id });
  await run(conn, principal, importsStart, { id: upload.id });
  await runImportJob(deps(conn), services.jobs.at(-1) as ImportJob);
  const done = await run<ImportView>(conn, principal, importsGet, { id: upload.id });
  return { upload, previewed, done };
}

async function fileExists(key: string | null): Promise<boolean> {
  return key !== null && (await env.BUCKET.head(key)) !== null;
}

async function importRow(conn: DbConnection, workspaceId: number, id: number) {
  return conn.db
    .selectFrom("imports")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

describe("CSV import", () => {
  it("previews counts, imports with the consent basis and tag, and writes an error file", async () => {
    const { conn, principal, workspaceId } = await owner();
    const list = await run<{ id: number }>(conn, principal, listsCreate, { name: "Students" });
    // Existing state: one contact to update, one unsubscribed, one suppressed.
    await run(conn, principal, contactsUpsert, { email: "old@example.com", firstName: "Old" });
    const leaver = await run<{ contact: { id: number } }>(conn, principal, contactsUpsert, {
      email: "leaver@example.com",
    });
    await run(conn, principal, contactsUpdate, { id: leaver.contact.id, unsubscribe: true });
    await run(conn, principal, suppressionsAdd, { emails: ["bounced@example.com"] });

    const csv =
      "﻿E-mail,First name,Last name,Cohort\r\n" +
      "Ana@Example.com ,Ana,Silva,2026\r\n" +
      "old@example.com,,Newname,2025\r\n" +
      "LEAVER@example.com,Lee,,2024\r\n" +
      "bounced@example.com,Bo,,2024\r\n" +
      "not-an-email,X,,\r\n" +
      ",Nobody,,\r\n" +
      "ana@example.com,Dup,,\r\n" +
      '"=HYPERLINK(""http://x"")",Evil,,\r\n';
    const { upload, previewed, done } = await importCsv(conn, principal, csv, {
      mapping: ["email", "first_name", "last_name", "field:cohort"],
      consentBasis: "existing_customer",
      tags: ["Course 101"],
      listIds: [list.id],
    });

    expect(upload.headers).toEqual(["E-mail", "First name", "Last name", "Cohort"]);
    expect(upload.sample[0]).toEqual(["Ana@Example.com ", "Ana", "Silva", "2026"]);
    const expected = {
      total: 8,
      new: 1,
      updated: 1,
      skippedUnsubscribed: 1,
      skippedSuppressed: 1,
      invalid: 3,
      duplicate: 1,
    };
    expect(previewed).toMatchObject({ status: "previewed", preview: expected });
    expect(previewed.estimatedRowWrites).toBeGreaterThan(0);
    expect(done).toMatchObject({ status: "completed", counts: expected, hasErrorFile: true });
    expect(done.errorCount).toBe(6);
    expect(done.rowsWritten).toBeGreaterThan(0);

    const contacts = await run<{
      items: {
        email: string;
        firstName: string | null;
        lastName: string | null;
        consentBasis: string;
        source: string;
        tags: { name: string }[];
        lists: { listId: number; status: string; source: string }[];
        fields: Record<string, string | null>;
      }[];
    }>(conn, principal, contactsList, { tagId: undefined });
    const byEmail = new Map(contacts.items.map((contact) => [contact.email, contact]));
    expect(byEmail.get("ana@example.com")).toMatchObject({
      firstName: "Ana",
      lastName: "Silva",
      consentBasis: "existing_customer",
      source: `import:${upload.id}`,
      tags: [expect.objectContaining({ name: "Course 101" })],
      lists: [
        expect.objectContaining({
          listId: list.id,
          status: "subscribed",
          source: `import:${upload.id}`,
        }),
      ],
      fields: { cohort: "2026" },
    });
    // A blank cell keeps the stored name.
    expect(byEmail.get("old@example.com")).toMatchObject({ firstName: "Old", lastName: "Newname" });
    expect(byEmail.get("leaver@example.com")).toMatchObject({ tags: [], lists: [] });
    expect(byEmail.has("bounced@example.com")).toBe(false);

    // The uploaded CSV is gone. The error file lists each skipped row with a reason.
    const row = await importRow(conn, workspaceId, upload.id);
    expect(row.file_key).toBeNull();
    expect(await env.BUCKET.list({ prefix: `imports/${workspaceId}/` })).toMatchObject({
      objects: [expect.objectContaining({ key: row.error_file_key })],
    });
    const link = await run<{ url: string }>(conn, principal, importsErrorFile, { id: upload.id });
    expect(link.url).toMatch(/^\/api\/files\//);
    const errorFile = await (await env.BUCKET.get(row.error_file_key as string))?.text();
    expect(errorFile).toBe(
      [
        csvLine(["row", "email", "reason"]),
        csvLine([3, "leaver@example.com", "Unsubscribed"]),
        csvLine([4, "bounced@example.com", "Suppressed"]),
        csvLine([5, "not-an-email", "Not a valid email address"]),
        csvLine([6, null, "No email address"]),
        csvLine([7, "ana@example.com", "Duplicate of an earlier row"]),
        csvLine([8, '=HYPERLINK("http://x")', "Not a valid email address"]),
      ].join(""),
    );
  });

  it("imports 5,000 rows in chunks within the per-step query budget, then deletes the file", async () => {
    const { conn, principal, workspaceId } = await owner("Five thousand");
    const lines = [csvLine(["email", "first_name"])];
    for (let i = 0; i < 5000; i++) lines.push(csvLine([`student${i}@example.com`, `Student ${i}`]));
    const upload = await run<ImportView>(conn, principal, importsCreate, {
      filename: "students.csv",
      content: lines.join(""),
    });
    await run(conn, principal, importsPreview, {
      id: upload.id,
      mapping: ["email", "first_name"],
      consentBasis: "existing_customer",
      tags: ["Course"],
    });
    await runImportJob(deps(conn), services.jobs.at(-1) as ImportJob);
    await run(conn, principal, importsStart, { id: upload.id });
    const job = services.jobs.at(-1) as ImportJob;
    const fileKey = (await importRow(conn, workspaceId, upload.id)).file_key;
    expect(await fileExists(fileKey)).toBe(true);

    // Drive the run as the Workflow does, one step per chunk, and measure each step.
    const seen = new Set<string>();
    let offset = 0;
    let chunks = 0;
    let maxQueries = 0;
    let rowsWritten = 0;
    for (;;) {
      const before = counting.counter.count;
      const outcome = await processImportChunk(deps(conn), job, offset, seen);
      maxQueries = Math.max(maxQueries, counting.counter.count - before);
      if (outcome.kind !== "chunk") throw new Error(`Unexpected ${outcome.kind}`);
      chunks += 1;
      rowsWritten += outcome.rowsWritten;
      for (const key of outcome.seen) seen.add(key);
      offset = outcome.nextOffset;
      if (outcome.done) break;
    }
    expect(chunks).toBe(5000 / IMPORT_CHUNK_ROWS);
    // Workers Free allows 50 D1 queries per invocation.
    expect(maxQueries).toBeLessThan(40);

    await finishImport(deps(conn), job, { rowsWritten });
    const done = await run<ImportView>(conn, principal, importsGet, { id: upload.id });
    expect(done).toMatchObject({ status: "completed", processedRows: 5000, hasErrorFile: false });
    expect(done.counts).toMatchObject({ new: 5000, invalid: 0, duplicate: 0 });
    expect(await fileExists(fileKey)).toBe(false);
    const count = await conn.db
      .selectFrom("contacts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(5000);
    // The estimate from the preview stays at or above the measured writes.
    const previewed = await run<ImportView>(conn, principal, importsGet, { id: upload.id });
    expect(rowsWritten).toBeLessThanOrEqual(previewed.estimatedRowWrites ?? 0);
    expect(rowsWritten).toBeGreaterThan((previewed.estimatedRowWrites ?? 0) * 0.6);
  });

  it("detects duplicates across chunks and reads quoted rows that cross the read window", async () => {
    const { conn, principal } = await owner();
    const note = `"${"long text, with a comma\n".repeat(40)}"`;
    const lines = ["email;note\n"];
    for (let i = 0; i < 260; i++) lines.push(`r${i}@example.com;${note}\n`);
    lines.push("r1@example.com;again\n");
    const { done, upload } = await importCsv(conn, principal, lines.join(""), {
      mapping: ["email", "field:note"],
      consentBasis: "explicit_opt_in",
    });
    expect(upload.delimiter).toBe(";");
    expect(done.counts).toMatchObject({ total: 261, new: 260, duplicate: 1 });
    const contact = await run<{ items: { fields: Record<string, string> }[] }>(
      conn,
      principal,
      contactsList,
      { search: "r259@" },
    );
    expect(contact.items[0]?.fields.note).toBe("long text, with a comma\n".repeat(40).trimEnd());
  });

  it("rejects an empty file and a file without a header", async () => {
    const { conn, principal } = await owner();
    for (const content of ["", "﻿", "  \r\n "]) {
      await expect(
        run(conn, principal, importsCreate, { filename: "empty.csv", content }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // A header without rows imports nothing.
    const { done } = await importCsv(conn, principal, "email\n", {
      mapping: ["email"],
      consentBasis: "unknown",
    });
    expect(done).toMatchObject({ status: "completed", counts: { total: 0, new: 0 } });
  });

  it("checks the mapping and the import state", async () => {
    const { conn, principal } = await owner();
    const upload = await run<ImportView>(conn, principal, importsCreate, {
      filename: "a.csv",
      content: "email,name\na@example.com,A\n",
    });
    for (const mapping of [
      ["ignore", "ignore"],
      ["email", "email"],
      ["email"],
      ["email", "bogus"],
    ]) {
      await expect(
        run(conn, principal, importsPreview, { id: upload.id, mapping, consentBasis: "unknown" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // The consent basis is required.
    await expect(
      run(conn, principal, importsPreview, { id: upload.id, mapping: ["email", "first_name"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(conn, principal, importsStart, { id: upload.id })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("lets a stale preview run write nothing, and does not repeat a committed chunk", async () => {
    const { conn, principal, workspaceId } = await owner();
    const upload = await run<ImportView>(conn, principal, importsCreate, {
      filename: "a.csv",
      content: "email\na@example.com\nb@example.com\n",
    });
    const config = { id: upload.id, mapping: ["email"], consentBasis: "unknown" };
    await run(conn, principal, importsPreview, config);
    const stale = services.jobs.at(-1) as ImportJob;
    await run(conn, principal, importsPreview, config);
    expect(await processImportChunk(deps(conn), stale, 0, new Set())).toEqual({ kind: "stale" });
    await runImportJob(deps(conn), services.jobs.at(-1) as ImportJob);

    await run(conn, principal, importsStart, { id: upload.id });
    const job = services.jobs.at(-1) as ImportJob;
    const first = await processImportChunk(deps(conn), job, 0, new Set());
    // A retry of the same step reads the chunk again but writes nothing.
    const retry = await processImportChunk(deps(conn), job, 0, new Set());
    expect(retry).toMatchObject({ kind: "chunk", rowsWritten: 0 });
    expect(first).toMatchObject({ kind: "chunk", done: true });
    const row = await importRow(conn, workspaceId, upload.id);
    expect(JSON.parse(row.counts ?? "{}")).toMatchObject({ total: 2, new: 2 });
  });

  it("keeps an API key from raising a basis of unknown through an import", async () => {
    const { conn, principal } = await owner();
    await run(conn, principal, contactsUpsert, { email: "u@example.com", consentBasis: "unknown" });
    const key = apiKeyPrincipal({
      workspaceId: principal.workspaceId,
      apiKeyId: 9,
      scopes: ["contacts:read", "contacts:write"],
      surface: "rest",
    });
    await importCsv(conn, key, "email\nu@example.com\nv@example.com\n", {
      mapping: ["email"],
      consentBasis: "existing_customer",
    });
    const list = await run<{ items: { email: string; consentBasis: string; id: number }[] }>(
      conn,
      principal,
      contactsList,
      {},
    );
    const byEmail = new Map(list.items.map((item) => [item.email, item]));
    expect(byEmail.get("u@example.com")?.consentBasis).toBe("unknown");
    expect(byEmail.get("v@example.com")?.consentBasis).toBe("existing_customer");

    // The owner may raise it.
    await importCsv(conn, principal, "email\nu@example.com\n", {
      mapping: ["email"],
      consentBasis: "existing_customer",
    });
    const raised = await run<{ consentBasis: string }>(conn, principal, contactsGet, {
      id: byEmail.get("u@example.com")?.id,
    });
    expect(raised.consentBasis).toBe("existing_customer");
  });

  it("pauses the run when D1 reports the daily limit", async () => {
    const { conn, principal, workspaceId } = await owner();
    const upload = await run<ImportView>(conn, principal, importsCreate, {
      filename: "a.csv",
      content: "email\na@example.com\n",
    });
    await run(conn, principal, importsPreview, {
      id: upload.id,
      mapping: ["email"],
      consentBasis: "unknown",
    });
    const limited = {
      ...conn,
      atomic: async () => {
        throw new Error("D1_ERROR: Your daily limits have been exceeded.");
      },
    } as DbConnection;
    const now = Date.UTC(2026, 9, 19, 15);
    const outcome = await processImportChunk(
      { db: limited, services },
      services.jobs.at(-1) as ImportJob,
      0,
      new Set(),
      now,
    );
    expect(outcome).toEqual({ kind: "paused", resumeAt: Date.UTC(2026, 9, 20, 0, 5) });
    const row = await importRow(conn, workspaceId, upload.id);
    expect(row.cursor_offset).toBe(0);
  });
});
