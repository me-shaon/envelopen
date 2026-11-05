import { beforeAll, describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  type TestServices,
  testDb,
  testServices,
} from "../../test/fixtures";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { listsCreate } from "../lists/operations";
import { sessionPrincipal } from "../principal";
import { BULK_MAX_IDS, contactsBulk } from "./bulk";
import { contactsUpsert } from "./operations";

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

const EMAILS = ["ada@example.com", "alan@example.com", "grace@example.com", "bob@other.org"];

async function setup() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Bulk");
  const principal = sessionPrincipal({ workspaceId, userId });
  const run = <O>(operation: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
  const ids: number[] = [];
  for (const email of EMAILS) {
    const out = await run<{ contact: { id: number } }>(contactsUpsert, {
      email,
      consentBasis: "explicit_opt_in",
      tags: email.endsWith("@example.com") ? ["Course"] : [],
    });
    ids.push(out.contact.id);
  }
  const list = await run<{ id: number }>(listsCreate, { name: "Newsletter" });
  const otherId = await createOwnedWorkspace(conn, userId, "Other");
  const other = sessionPrincipal({ workspaceId: otherId, userId });
  const otherRun = <O>(operation: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(other, operation, input, { db: conn, services }) as Promise<O>;

  const members = async (listId: number) =>
    conn.db
      .selectFrom("list_members")
      .select(["contact_id", "status"])
      .where("workspace_id", "=", workspaceId)
      .where("list_id", "=", listId)
      .orderBy("contact_id")
      .execute();
  const tagged = async (tagId: number) =>
    (
      await conn.db
        .selectFrom("contact_tags")
        .select("contact_id")
        .where("workspace_id", "=", workspaceId)
        .where("tag_id", "=", tagId)
        .orderBy("contact_id")
        .execute()
    ).map((row) => row.contact_id);
  const storedCount = async (listId: number) =>
    (
      await conn.db
        .selectFrom("lists")
        .select("subscribed_count")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", listId)
        .executeTakeFirstOrThrow()
    ).subscribed_count;

  return { conn, workspaceId, run, otherRun, ids, listId: list.id, members, tagged, storedCount };
}

type Result = { matched: number; changed: number; listId: number | null; tagId: number | null };

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  return isOperationError(error) ? error.code : error;
}

describe("contacts.bulk", () => {
  it("adds the selected contacts to a list once, however often it runs", async () => {
    const { run, ids, listId, members, storedCount } = await setup();
    const first = await run<Result>(contactsBulk, {
      action: "add_to_list",
      listId,
      contactIds: [ids[0], ids[1], ids[1]],
    });
    expect(first).toEqual({ matched: 2, changed: 2, listId, tagId: null });
    const again = await run<Result>(contactsBulk, {
      action: "add_to_list",
      listId,
      contactIds: [ids[0], ids[1], ids[2]],
    });
    expect(again).toMatchObject({ matched: 3, changed: 1 });
    expect((await members(listId)).map((row) => row.contact_id)).toEqual(ids.slice(0, 3));
    expect(await storedCount(listId)).toBe(3);
  });

  it("adds every contact that matches the filters, and only in this workspace", async () => {
    const { run, otherRun, ids, listId, members } = await setup();
    for (const email of EMAILS) {
      await otherRun(contactsUpsert, { email, consentBasis: "explicit_opt_in", tags: ["Course"] });
    }
    const result = await run<Result>(contactsBulk, {
      action: "add_to_list",
      listId,
      filters: { search: "example.com" },
    });
    expect(result).toMatchObject({ matched: 3, changed: 3 });
    expect((await members(listId)).map((row) => row.contact_id)).toEqual(ids.slice(0, 3));

    const everyone = await run<Result>(contactsBulk, {
      action: "add_to_list",
      listId,
      filters: {},
    });
    expect(everyone).toMatchObject({ matched: 4, changed: 1 });
  });

  it("keeps an unsubscribed membership unsubscribed, and keeps its record on remove", async () => {
    const { conn, workspaceId, run, ids, listId, members } = await setup();
    await run(contactsBulk, { action: "add_to_list", listId, contactIds: ids });
    await conn.db
      .updateTable("list_members")
      .set({ status: "unsubscribed" })
      .where("workspace_id", "=", workspaceId)
      .where("list_id", "=", listId)
      .where("contact_id", "=", ids[0] as number)
      .execute();

    const add = await run<Result>(contactsBulk, { action: "add_to_list", listId, contactIds: ids });
    expect(add).toMatchObject({ matched: 4, changed: 0 });

    const remove = await run<Result>(contactsBulk, {
      action: "remove_from_list",
      listId,
      filters: {},
    });
    expect(remove).toMatchObject({ matched: 4, changed: 3 });
    expect(await members(listId)).toEqual([{ contact_id: ids[0], status: "unsubscribed" }]);
  });

  it("adds a tag by name without regard to case, and removes it through a filter", async () => {
    const { run, ids, tagged } = await setup();
    const add = await run<Result>(contactsBulk, {
      action: "add_tag",
      tagName: "course",
      contactIds: ids,
    });
    // The upsert tagged the three example.com contacts with "Course" already.
    expect(add).toMatchObject({ matched: 4, changed: 1 });
    const tagId = add.tagId as number;
    expect(await tagged(tagId)).toEqual(ids);

    const fresh = await run<Result>(contactsBulk, {
      action: "add_tag",
      tagName: "  VIP ",
      contactIds: [ids[3]],
    });
    expect(fresh).toMatchObject({ matched: 1, changed: 1 });
    expect(fresh.tagId).not.toBe(tagId);

    const remove = await run<Result>(contactsBulk, {
      action: "remove_tag",
      tagId,
      filters: { search: "a" },
    });
    // ada, alan, and grace contain "a". bob@other.org does not.
    expect(remove).toMatchObject({ matched: 3, changed: 3 });
    expect(await tagged(tagId)).toEqual([ids[3]]);
  });

  it("ignores contact ids of another workspace", async () => {
    const { run, otherRun, listId, members } = await setup();
    const out = await otherRun<{ contact: { id: number } }>(contactsUpsert, {
      email: "stranger@example.com",
      consentBasis: "explicit_opt_in",
    });
    const result = await run<Result>(contactsBulk, {
      action: "add_to_list",
      listId,
      contactIds: [out.contact.id],
    });
    expect(result).toMatchObject({ matched: 0, changed: 0 });
    expect(await members(listId)).toEqual([]);
  });

  it("refuses a wrong selection or a missing target", async () => {
    const { run, otherRun, ids, listId } = await setup();
    expect(await failure(run(contactsBulk, { action: "add_to_list", listId }))).toBe(
      "invalid_input",
    );
    expect(
      await failure(
        run(contactsBulk, { action: "add_to_list", listId, contactIds: ids, filters: {} }),
      ),
    ).toBe("invalid_input");
    expect(await failure(run(contactsBulk, { action: "add_to_list", contactIds: ids }))).toBe(
      "invalid_input",
    );
    expect(await failure(run(contactsBulk, { action: "remove_tag", contactIds: ids }))).toBe(
      "invalid_input",
    );
    expect(
      await failure(run(contactsBulk, { action: "remove_tag", tagId: 999_999, contactIds: ids })),
    ).toBe("not_found");
    // A list of another workspace does not exist here.
    const otherList = await otherRun<{ id: number }>(listsCreate, { name: "Theirs" });
    expect(
      await failure(
        run(contactsBulk, { action: "add_to_list", listId: otherList.id, contactIds: ids }),
      ),
    ).toBe("not_found");
    expect(
      await failure(
        run(contactsBulk, {
          action: "add_to_list",
          listId,
          contactIds: Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => i + 1),
        }),
      ),
    ).toBe("invalid_input");
  });

  it("writes one audit row with the counts", async () => {
    const { conn, workspaceId, run, ids, listId } = await setup();
    await run(contactsBulk, { action: "add_to_list", listId, contactIds: ids });
    const row = await conn.db
      .selectFrom("audit_log")
      .select(["action", "target_type", "target_id", "metadata"])
      .where("workspace_id", "=", workspaceId)
      .where("action", "=", "contacts.bulk")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ target_type: "list", target_id: String(listId) });
    expect(JSON.parse(row.metadata ?? "{}")).toEqual({
      action: "add_to_list",
      selectedBy: "ids",
      matched: 4,
      changed: 4,
    });
  });
});
