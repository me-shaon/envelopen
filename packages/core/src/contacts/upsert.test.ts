import type { DbConnection } from "@envelopen/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  insertContact,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { consentList, consentRecord } from "../consent/operations";
import { CONSENT_UPGRADE_BLOCKED } from "../consent/rules";
import { OperationError } from "../errors";
import { runOperation } from "../executor";
import { listsAddContacts, listsCreate, listsRemoveContact } from "../lists/operations";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import type { ApiKeyScope } from "../scopes";
import { suppressionsAdd, suppressionsList } from "../suppression/operations";
import {
  contactsAddTags,
  contactsCount,
  contactsDelete,
  contactsGet,
  contactsList,
  contactsUpdate,
  contactsUpsert,
} from "./operations";

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

async function owner(name = "Contacts") {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, name);
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

function keyPrincipal(
  workspaceId: number,
  scopes: ApiKeyScope[] = ["contacts:read", "contacts:write", "lists:write", "stats:read"],
  apiKeyId = 41,
  surface: "rest" | "mcp" = "rest",
): Principal {
  return apiKeyPrincipal({ workspaceId, apiKeyId, scopes, surface });
}

function run<O>(
  conn: DbConnection,
  principal: Principal,
  operation: Parameters<typeof runOperation>[1],
  input: unknown,
) {
  return runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
}

type Upserted = Awaited<ReturnType<typeof contactsUpsert.handler>> & {
  contact: { id: number; status: string; consentBasis: string; source: string };
};

describe("contacts.upsert (R73)", () => {
  it("upserts `Ana@Example.com ` and `ana@example.com` to one contact", async () => {
    const { conn, principal } = await owner();
    const first = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "Ana@Example.com ",
      firstName: "Ana",
    });
    const second = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "ana@example.com",
      lastName: "Silva",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.contact).toMatchObject({
      id: first.contact.id,
      email: "ana@example.com",
      firstName: "Ana",
      lastName: "Silva",
      status: "subscribed",
    });
    const page = await run<{ items: unknown[] }>(conn, principal, contactsList, {});
    expect(page.items).toHaveLength(1);
  });

  it("keeps an unsubscribed member unsubscribed", async () => {
    const { conn, principal } = await owner();
    const list = await run<{ id: number }>(conn, principal, listsCreate, { name: "Students" });
    const { contact } = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "leaver@example.com",
      listIds: [list.id],
    });
    await run(conn, principal, contactsUpdate, { id: contact.id, unsubscribe: true });

    const api = keyPrincipal(principal.workspaceId);
    const again = await run<Upserted & { contact: { lists: { status: string }[] } }>(
      conn,
      api,
      contactsUpsert,
      { email: "LEAVER@example.com", listIds: [list.id], tags: ["Course"] },
    );
    expect(again.contact.status).toBe("unsubscribed");
    expect(again.contact.lists).toEqual([
      expect.objectContaining({ listId: list.id, status: "unsubscribed", source: "ui" }),
    ]);

    // A list-only unsubscribe stays too.
    const other = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "list-leaver@example.com",
      listIds: [list.id],
    });
    await conn.db
      .updateTable("list_members")
      .set({ status: "unsubscribed", status_source: "one_click", status_at: 1 })
      .where("workspace_id", "=", principal.workspaceId)
      .where("contact_id", "=", other.contact.id)
      .execute();
    const added = await run<{ added: number; keptUnsubscribed: number }>(
      conn,
      principal,
      listsAddContacts,
      { id: list.id, contactIds: [other.contact.id] },
    );
    expect(added).toEqual({ added: 0, keptUnsubscribed: 1 });
    // Removing a member leaves the unsubscribe record.
    expect(
      await run(conn, principal, listsRemoveContact, { id: list.id, contactId: other.contact.id }),
    ).toEqual({ removed: false });
    const after = await run<{ lists: { status: string; source: string }[] }>(
      conn,
      principal,
      contactsGet,
      { id: other.contact.id },
    );
    expect(after.lists).toEqual([
      expect.objectContaining({ status: "unsubscribed", source: "one_click" }),
    ]);
  });

  it("keeps the suppression of a suppressed address", async () => {
    const { conn, principal } = await owner();
    await run(conn, principal, suppressionsAdd, { emails: ["Blocked@Example.com"] });
    const result = await run<Upserted>(conn, keyPrincipal(principal.workspaceId), contactsUpsert, {
      email: "blocked@example.com ",
      consentBasis: "explicit_opt_in",
    });
    expect(result.contact.status).toBe("suppressed");
    const suppressions = await run<{ items: { email: string | null; reason: string }[] }>(
      conn,
      principal,
      suppressionsList,
      {},
    );
    expect(suppressions.items).toEqual([
      expect.objectContaining({ email: "blocked@example.com", reason: "manual" }),
    ]);
    // The row stores a keyed hash, never the address.
    const stored = await conn.db
      .selectFrom("suppressions")
      .select("email_hash")
      .where("workspace_id", "=", principal.workspaceId)
      .executeTakeFirstOrThrow();
    expect(stored.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.email_hash).toBe(await services.hashEmail("blocked@example.com"));
  });

  it("does not let an API upsert change a consent basis from unknown to existing customer", async () => {
    const { conn, principal } = await owner();
    const api = keyPrincipal(principal.workspaceId);
    const created = await run<Upserted>(conn, api, contactsUpsert, {
      email: "unknown@example.com",
      consentBasis: "unknown",
    });
    const result = await run<Upserted>(conn, api, contactsUpsert, {
      email: "unknown@example.com",
      consentBasis: "existing_customer",
    });
    expect(result.warnings).toEqual([CONSENT_UPGRADE_BLOCKED]);
    expect(result.contact.consentBasis).toBe("unknown");

    await expect(
      run(conn, api, consentRecord, { id: created.contact.id, basis: "existing_customer" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // The owner may record the upgrade. The history is append-only.
    await run(conn, principal, consentRecord, {
      id: created.contact.id,
      basis: "existing_customer",
      note: "Bought the course in 2025",
    });
    const history = await run<{ items: { basis: string; source: string; note: string | null }[] }>(
      conn,
      principal,
      consentList,
      { id: created.contact.id },
    );
    expect(history.items.map((event) => event.basis)).toEqual(["existing_customer", "unknown"]);
    expect(history.items[0]).toMatchObject({ source: "ui", note: "Bought the course in 2025" });
  });

  it("covers F2: an API upsert with a tag and a consent basis records the source api_key:<id>", async () => {
    const { conn, principal } = await owner();
    const api = keyPrincipal(principal.workspaceId, ["contacts:write"], 77);
    const result = await run<Upserted & { contact: { tags: { name: string }[] } }>(
      conn,
      api,
      contactsUpsert,
      {
        email: "student@example.com",
        firstName: "Sam",
        consentBasis: "existing_customer",
        tags: ["Course 101"],
        fields: { cohort: "2026-10" },
      },
    );
    expect(result.created).toBe(true);
    expect(result.contact).toMatchObject({
      source: "api_key:77",
      consentBasis: "existing_customer",
      consentSource: "api_key:77",
      tags: [expect.objectContaining({ name: "Course 101" })],
      fields: { cohort: "2026-10" },
    });
    const events = await conn.db
      .selectFrom("consent_events")
      .select(["basis", "source", "actor_type", "actor_id"])
      .where("workspace_id", "=", principal.workspaceId)
      .where("contact_id", "=", result.contact.id)
      .execute();
    expect(events).toEqual([
      { basis: "existing_customer", source: "api_key:77", actor_type: "api_key", actor_id: "77" },
    ]);
    // The same tag name in another case is the same tag.
    const tagged = await run<{ tags: unknown[] }>(conn, principal, contactsAddTags, {
      id: result.contact.id,
      tags: ["course 101"],
    });
    expect(tagged.tags).toHaveLength(1);
  });

  it("rejects an invalid address", async () => {
    const { conn, principal } = await owner();
    for (const email of ["", "not-an-email", "a@b", "two@@example.com", "a b@example.com"]) {
      await expect(run(conn, principal, contactsUpsert, { email })).rejects.toBeInstanceOf(
        OperationError,
      );
    }
  });
});

describe("contact state", () => {
  it("keeps an unsubscribed contact visible, and filters by status", async () => {
    const { conn, principal } = await owner();
    const list = await run<{ id: number }>(conn, principal, listsCreate, { name: "News" });
    const a = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "a@example.com",
      listIds: [list.id],
    });
    await run(conn, principal, contactsUpsert, { email: "b@example.com", listIds: [list.id] });
    await run(conn, principal, contactsUpsert, { email: "c@example.com", tags: ["VIP"] });
    await run(conn, principal, suppressionsAdd, { emails: ["c@example.com"] });
    const unsubscribed = await run<{ status: string; unsubscribeSource: string }>(
      conn,
      principal,
      contactsUpdate,
      { id: a.contact.id, unsubscribe: true },
    );
    expect(unsubscribed).toMatchObject({ status: "unsubscribed", unsubscribeSource: "ui" });

    const emails = async (input: Record<string, unknown>) =>
      (await run<{ items: { email: string }[] }>(conn, principal, contactsList, input)).items.map(
        (item) => item.email,
      );
    expect(await emails({})).toEqual(["c@example.com", "b@example.com", "a@example.com"]);
    expect(await emails({ status: "unsubscribed" })).toEqual(["a@example.com"]);
    expect(await emails({ status: "suppressed" })).toEqual(["c@example.com"]);
    expect(await emails({ status: "subscribed" })).toEqual(["b@example.com"]);
    expect(await emails({ listId: list.id, status: "unsubscribed" })).toEqual(["a@example.com"]);
    expect(await emails({ listId: list.id })).toEqual(["b@example.com", "a@example.com"]);
    expect(await emails({ search: "B@EX" })).toEqual(["b@example.com"]);
    expect(await emails({ search: "%" })).toEqual([]);

    const counts = await run(conn, principal, contactsCount, { listId: list.id });
    expect(counts).toEqual({
      matching: 2,
      total: 3,
      subscribed: 1,
      unsubscribed: 1,
      suppressed: 1,
    });
  });

  it("pages through contacts newest first with a cursor", async () => {
    const { conn, principal } = await owner();
    for (const n of [1, 2, 3, 4, 5]) {
      await insertContact(conn, principal.workspaceId, { email: `p${n}@example.com` });
    }
    const first = await run<{ items: { email: string }[]; nextCursor: string | null }>(
      conn,
      principal,
      contactsList,
      { limit: 2 },
    );
    expect(first.items.map((item) => item.email)).toEqual(["p5@example.com", "p4@example.com"]);
    const second = await run<{ items: { email: string }[]; nextCursor: string | null }>(
      conn,
      principal,
      contactsList,
      { limit: 2, cursor: first.nextCursor },
    );
    expect(second.items.map((item) => item.email)).toEqual(["p3@example.com", "p2@example.com"]);
  });

  it("keeps an unsubscribed address suppressed after the contact is deleted", async () => {
    const { conn, principal } = await owner();
    const { contact } = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "gone@example.com",
    });
    await run(conn, principal, contactsUpdate, { id: contact.id, unsubscribe: true });
    expect(await run(conn, principal, contactsDelete, { id: contact.id })).toEqual({
      id: contact.id,
      suppressed: true,
    });
    const back = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "gone@example.com",
    });
    expect(back.contact.status).toBe("suppressed");

    // A contact who never unsubscribed leaves no suppression.
    const plain = await run<Upserted>(conn, principal, contactsUpsert, {
      email: "plain@example.com",
    });
    expect(await run(conn, principal, contactsDelete, { id: plain.contact.id })).toEqual({
      id: plain.contact.id,
      suppressed: false,
    });
  });
});

describe("isolation and scopes", () => {
  it("keeps contacts of one workspace out of another", async () => {
    const one = await owner("One");
    const two = await owner("Two");
    const a = await run<Upserted>(one.conn, one.principal, contactsUpsert, {
      email: "same@example.com",
    });
    const b = await run<Upserted>(two.conn, two.principal, contactsUpsert, {
      email: "same@example.com",
    });
    expect(a.contact.id).not.toBe(b.contact.id);
    await expect(
      run(two.conn, two.principal, contactsGet, { id: a.contact.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      run(two.conn, two.principal, contactsUpdate, { id: a.contact.id, unsubscribe: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    const twoList = await run<{ id: number }>(two.conn, two.principal, listsCreate, { name: "L" });
    await expect(
      run(one.conn, one.principal, contactsUpsert, {
        email: "x@example.com",
        listIds: [twoList.id],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    // A suppression in one workspace does not suppress the address in another.
    await run(one.conn, one.principal, suppressionsAdd, { emails: ["same@example.com"] });
    const other = await run<{ status: string }>(two.conn, two.principal, contactsGet, {
      id: b.contact.id,
    });
    expect(other.status).toBe("subscribed");
  });

  it("denies operations without the scope, and keeps delete away from MCP", async () => {
    const { conn, principal } = await owner();
    const readOnly = keyPrincipal(principal.workspaceId, ["contacts:read"]);
    await expect(
      run(conn, readOnly, contactsUpsert, { email: "x@example.com" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run(conn, readOnly, listsCreate, { name: "x" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(run(conn, readOnly, suppressionsList, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    const statsOnly = keyPrincipal(principal.workspaceId, ["stats:read"]);
    await expect(run(conn, statsOnly, contactsList, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    const mcp = keyPrincipal(
      principal.workspaceId,
      ["contacts:read", "contacts:write", "contacts:delete"],
      5,
      "mcp",
    );
    const { contact } = await run<Upserted>(conn, mcp, contactsUpsert, { email: "m@example.com" });
    await expect(run(conn, mcp, contactsDelete, { id: contact.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      run(conn, mcp, consentRecord, { id: contact.id, basis: "explicit_opt_in" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
