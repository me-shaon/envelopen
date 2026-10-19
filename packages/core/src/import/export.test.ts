import { env } from "cloudflare:workers";
import type { DbConnection } from "@envelopen/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  TEST_SIGNING_KEY,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { contactsUpdate, contactsUpsert } from "../contacts/operations";
import { runOperation } from "../executor";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import { suppressionsAdd } from "../suppression/operations";
import { cleanupExpiredFiles } from "./cleanup";
import { parseCsv } from "./csv";
import { exportsCreate, exportsList } from "./export";
import { createFileLinkSigner } from "./file-links";
import { FILE_TTL_MS } from "./model";

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

async function owner() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Export");
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

function run<O>(
  conn: DbConnection,
  principal: Principal,
  operation: Parameters<typeof runOperation>[1],
  input: unknown,
  now?: number,
) {
  return runOperation(principal, operation, input, {
    db: conn,
    services,
    ...(now === undefined ? {} : { now: () => now }),
  }) as Promise<O>;
}

interface ExportView {
  id: number;
  status: string;
  rowCount: number;
  downloadUrl: string | null;
  expiresAt: number;
  createdAt: number;
}

async function fileOf(url: string) {
  const signer = await createFileLinkSigner(TEST_SIGNING_KEY);
  const file = await signer.verify(url.slice("/api/files/".length));
  if (!file) throw new Error("The link does not verify.");
  const object = await env.BUCKET.get(file.key);
  return { file, text: (await object?.text()) ?? null };
}

describe("contact export", () => {
  it("quotes an exported cell =HYPERLINK(...) so it starts with a quote", async () => {
    const { conn, principal } = await owner();
    await run(conn, principal, contactsUpsert, {
      email: "evil@example.com",
      firstName: '=HYPERLINK("http://evil.example","Click")',
      lastName: "-1+2",
      tags: ["@risk", "Course"],
    });
    const created = await run<ExportView>(conn, principal, exportsCreate, {});
    expect(created).toMatchObject({ status: "ready", rowCount: 1 });
    const { text } = await fileOf(created.downloadUrl as string);
    const [header, row] = parseCsv(text ?? "", { final: true }).rows;
    const cell = (name: string) => row?.[header?.indexOf(name) ?? -1];
    expect(cell("first_name")).toBe(`'=HYPERLINK("http://evil.example","Click")`);
    expect(cell("last_name")).toBe("'-1+2");
    expect(cell("tags")).toBe("'@risk; Course");
    expect(cell("email")).toBe("evil@example.com");
    expect(cell("status")).toBe("subscribed");
  });

  it("exports the filtered contacts with status and custom fields", async () => {
    const { conn, principal } = await owner();
    await run(conn, principal, contactsUpsert, {
      email: "a@example.com",
      fields: { cohort: "2026" },
    });
    const b = await run<{ contact: { id: number } }>(conn, principal, contactsUpsert, {
      email: "b@example.com",
    });
    await run(conn, principal, contactsUpdate, { id: b.contact.id, unsubscribe: true });
    await run(conn, principal, contactsUpsert, { email: "c@example.com" });
    await run(conn, principal, suppressionsAdd, { emails: ["c@example.com"] });

    const all = await run<ExportView>(conn, principal, exportsCreate, {});
    const rows = parseCsv((await fileOf(all.downloadUrl as string)).text ?? "", {
      final: true,
    }).rows;
    expect(rows[0]).toContain("cohort");
    expect(rows.slice(1).map((row) => [row[0], row[3], row.at(-1)])).toEqual([
      ["a@example.com", "subscribed", "2026"],
      ["b@example.com", "unsubscribed", ""],
      ["c@example.com", "suppressed", ""],
    ]);

    const unsubscribed = await run<ExportView>(conn, principal, exportsCreate, {
      status: "unsubscribed",
    });
    expect(unsubscribed.rowCount).toBe(1);
  });

  it("expires the download link after 24 hours, and the cron deletes the file", async () => {
    const { conn, principal } = await owner();
    await run(conn, principal, contactsUpsert, { email: "a@example.com" });
    const created = await run<ExportView>(conn, principal, exportsCreate, {});
    expect(created.expiresAt - created.createdAt).toBe(FILE_TTL_MS);
    const { file } = await fileOf(created.downloadUrl as string);

    const signer = await createFileLinkSigner(TEST_SIGNING_KEY);
    const token = (created.downloadUrl as string).slice("/api/files/".length);
    expect(await signer.verify(token, created.expiresAt + 1)).toBeNull();
    // A changed token does not verify.
    expect(await signer.verify(`${token.slice(0, -2)}xx`)).toBeNull();

    const later = created.expiresAt + 1;
    const listed = await run<{ items: ExportView[] }>(conn, principal, exportsList, {}, later);
    expect(listed.items[0]).toMatchObject({ status: "expired", downloadUrl: null });

    await cleanupExpiredFiles(conn, env.BUCKET, created.expiresAt - 1);
    expect(await env.BUCKET.head(file.key)).not.toBeNull();
    await cleanupExpiredFiles(conn, env.BUCKET, later);
    expect(await env.BUCKET.head(file.key)).toBeNull();
  });

  it("needs the contacts:export scope", async () => {
    const { conn, principal } = await owner();
    const key = apiKeyPrincipal({
      workspaceId: principal.workspaceId,
      apiKeyId: 3,
      scopes: ["contacts:read", "contacts:write"],
      surface: "rest",
    });
    await expect(run(conn, key, exportsCreate, {})).rejects.toMatchObject({ code: "forbidden" });
    const exporter = apiKeyPrincipal({
      workspaceId: principal.workspaceId,
      apiKeyId: 4,
      scopes: ["contacts:export"],
      surface: "mcp",
    });
    // Export is "later" for MCP.
    await expect(run(conn, exporter, exportsCreate, {})).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
