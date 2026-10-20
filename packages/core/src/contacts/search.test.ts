import type { DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { runOperation } from "../executor";
import { buildContactsCsv } from "../import/export";
import { listsAddContacts, listsCreate } from "../lists/operations";
import { sessionPrincipal } from "../principal";
import {
  contactsCount,
  contactsDelete,
  contactsList,
  contactsUpdate,
  contactsUpsert,
} from "./operations";
import type { ContactFilters } from "./query";

// Contact search matches part of the email address or the name, without regard to ASCII
// case. These cases compare it with a LIKE over every contact, page by page, with the
// other filters, and in the export.

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

const PEOPLE: [string, string | null, string | null][] = [
  ["ada.lovelace@example.com", "Ada", "Lovelace"],
  ["alan@turing.org", "Alan", "Turing"],
  ["grace.hopper@navy.mil", "Grace", "Hopper"],
  ["percent%sign@example.com", "Per", "Cent"],
  ["under_score@example.com", null, "Score"],
  ["quote@example.com", 'Say "hi"', null],
  ["zoe@example.com", "Zoë", "Ünal"],
  ["mary.ann@example.com", "Mary Ann", "Smith"],
  ["lovelace.fan@fans.net", "Fan", null],
  ["bob@example.com", null, null],
];

async function setup() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Search");
  const principal = sessionPrincipal({ workspaceId, userId });
  const run = <O>(operation: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
  const ids: number[] = [];
  for (const [email, firstName, lastName] of PEOPLE) {
    const out = await run<{ contact: { id: number } }>(contactsUpsert, {
      email,
      firstName,
      lastName,
      consentBasis: "explicit_opt_in",
    });
    ids.push(out.contact.id);
  }
  // Another workspace with the same names: its contacts never show up.
  const otherId = await createOwnedWorkspace(conn, userId, "Other");
  const other = sessionPrincipal({ workspaceId: otherId, userId });
  for (const [email, firstName, lastName] of PEOPLE) {
    await runOperation(
      other,
      contactsUpsert,
      { email, firstName, lastName, consentBasis: "explicit_opt_in" },
      { db: conn, services },
    );
  }
  return { conn, workspaceId, run, ids };
}

/** The earlier search: LIKE over every contact of the workspace, newest first. */
async function reference(conn: DbConnection, workspaceId: number, text: string) {
  const pattern = `%${text.toLowerCase().replaceAll(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { rows } = await sql<{
    id: number;
  }>`SELECT id FROM contacts c WHERE workspace_id = ${workspaceId}
AND lower(c.email || ' ' || coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) LIKE ${pattern} ESCAPE '\\'
ORDER BY id DESC`.execute(conn.db);
  return rows.map((row) => row.id);
}

type ListPage = { items: { id: number }[]; nextCursor: string | null };

async function searchAll(
  run: <O>(operation: Parameters<typeof runOperation>[1], input: unknown) => Promise<O>,
  filters: ContactFilters,
  limit = 2,
) {
  const found: number[] = [];
  let cursor: string | null = null;
  do {
    const page: ListPage = await run<ListPage>(contactsList, {
      ...filters,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

describe("contact search", () => {
  it("finds the same contacts as LIKE, page by page, for short and long texts", async () => {
    const { conn, workspaceId, run } = await setup();
    const texts = [
      "a",
      "ov",
      "ace",
      "LOVELACE",
      "lace l",
      "e.com",
      "%",
      "t%s",
      "_sc",
      'y "h',
      "zoë",
      "ÜNAL",
      "ünal",
      "y an",
      "nothing-here",
      "  hopper  ",
    ];
    for (const text of texts) {
      const expected = await reference(conn, workspaceId, text.trim());
      expect({ text, found: await searchAll(run, { search: text }) }).toEqual({
        text,
        found: expected,
      });
      const count = await run<{ matching: number }>(contactsCount, { search: text });
      expect({ text, matching: count.matching }).toEqual({ text, matching: expected.length });
    }
  });

  it("combines the search with the list and status filters", async () => {
    const { conn, workspaceId, run, ids } = await setup();
    const list = await run<{ id: number }>(listsCreate, { name: "Fans" });
    await run(listsAddContacts, { id: list.id, contactIds: ids.slice(0, 6) });
    await run(contactsUpdate, { id: ids[0], unsubscribe: true });
    const all = await reference(conn, workspaceId, "example");
    const members = new Set(ids.slice(0, 6));
    expect(await searchAll(run, { search: "example", listId: list.id })).toEqual(
      all.filter((id) => members.has(id)),
    );
    expect(await searchAll(run, { search: "example", status: "unsubscribed" })).toEqual(
      all.filter((id) => id === ids[0]),
    );
    expect(
      await searchAll(run, { search: "example", listId: list.id, status: "subscribed" }),
    ).toEqual(all.filter((id) => members.has(id) && id !== ids[0]));
  });

  it("follows name changes and deletes", async () => {
    const { run, ids } = await setup();
    const [ada, alan] = ids as [number, number];
    expect(await searchAll(run, { search: "lovelace" })).toContain(ada);
    await run(contactsUpdate, { id: ada, lastName: "Byron" });
    expect(await searchAll(run, { search: "byron" })).toEqual([ada]);
    // The address still holds the old name.
    expect(await searchAll(run, { search: "lovelace" })).toContain(ada);
    expect(await searchAll(run, { search: "ada byron" })).toEqual([ada]);
    expect(await searchAll(run, { search: "ada lovelace" })).toEqual([]);
    await run(contactsDelete, { id: alan });
    expect(await searchAll(run, { search: "turing" })).toEqual([]);
  });

  it("exports the contacts that a search finds", async () => {
    const { conn, workspaceId } = await setup();
    const csv = await buildContactsCsv(conn.db, workspaceId, { search: "lovelace" });
    expect(csv.rows).toBe(2);
    expect(csv.csv).toContain("ada.lovelace@example.com");
    expect(csv.csv).toContain("lovelace.fan@fans.net");
  });
});
