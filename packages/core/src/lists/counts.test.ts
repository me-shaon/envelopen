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
import {
  contactsAddTags,
  contactsDelete,
  contactsRemoveTag,
  contactsUpdate,
  contactsUpsert,
} from "../contacts/operations";
import { subscribeContacts, tagContacts } from "../contacts/writes";
import {
  resubscribe,
  type Subscription,
  savePreferences,
  unsubscribeAll,
} from "../events/subscription";
import { runOperation } from "../executor";
import { contactsErase } from "../gdpr/operations";
import { sessionPrincipal } from "../principal";
import { suppressionsAdd } from "../suppression/operations";
import { repairCounts } from "./counts";
import {
  listsAddContacts,
  listsCreate,
  listsDelete,
  listsList,
  listsRemoveContact,
  tagsCreate,
  tagsDelete,
  tagsList,
} from "./operations";

// The stored member counts (migration 0014) must equal a COUNT(*) after any sequence of
// writes. The test drives every write path that changes a membership, in a random order
// from a fixed seed, and compares after each step.

let services: TestServices;
beforeAll(async () => {
  services = await testServices();
});

/** A small seeded random generator (mulberry32), so a failure repeats. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Counts");
  const principal = sessionPrincipal({ workspaceId, userId });
  const run = <O>(operation: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
  return { conn, workspaceId, run };
}

interface Mismatch {
  kind: string;
  id: number;
  stored: number[];
  counted: number[];
}

/** Lists and tags whose stored counts differ from COUNT(*), and the API counts too. */
async function mismatches(conn: DbConnection, workspaceId: number): Promise<Mismatch[]> {
  const lists = await sql<{ id: number; ss: number; su: number; cs: number; cu: number }>`
SELECT l.id, l.subscribed_count AS ss, l.unsubscribed_count AS su,
  (SELECT count(*) FROM list_members m WHERE m.list_id = l.id AND m.status = 'subscribed') AS cs,
  (SELECT count(*) FROM list_members m WHERE m.list_id = l.id AND m.status = 'unsubscribed') AS cu
FROM lists l WHERE l.workspace_id = ${workspaceId}`.execute(conn.db);
  const tags = await sql<{ id: number; sc: number; cc: number }>`
SELECT t.id, t.contact_count AS sc, (SELECT count(*) FROM contact_tags ct WHERE ct.tag_id = t.id) AS cc
FROM tags t WHERE t.workspace_id = ${workspaceId}`.execute(conn.db);
  const out: Mismatch[] = [];
  for (const row of lists.rows) {
    if (row.ss !== row.cs || row.su !== row.cu) {
      out.push({ kind: "list", id: row.id, stored: [row.ss, row.su], counted: [row.cs, row.cu] });
    }
  }
  for (const row of tags.rows) {
    if (row.sc !== row.cc)
      out.push({ kind: "tag", id: row.id, stored: [row.sc], counted: [row.cc] });
  }
  return out;
}

async function ids(conn: DbConnection, table: "contacts" | "lists" | "tags", workspaceId: number) {
  const rows = await conn.db
    .selectFrom(table)
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .orderBy("id")
    .execute();
  return rows.map((row) => row.id);
}

async function subscription(
  conn: DbConnection,
  workspaceId: number,
  campaignId: number,
  contactId: number,
): Promise<Subscription> {
  const contact = await conn.db
    .selectFrom("contacts")
    .select(["email", "unsubscribed_at"])
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", contactId)
    .executeTakeFirstOrThrow();
  const lists = await conn.db
    .selectFrom("list_members as m")
    .innerJoin("lists as l", "l.id", "m.list_id")
    .select(["l.id", "l.name", "m.status"])
    .where("m.workspace_id", "=", workspaceId)
    .where("m.contact_id", "=", contactId)
    .execute();
  return {
    workspaceId,
    workspaceName: "Counts",
    campaignId,
    recipientId: 0,
    contactId,
    email: contact.email,
    unsubscribedAt: contact.unsubscribed_at,
    suppressed: false,
    lists,
  };
}

describe("stored member counts", () => {
  it("equal COUNT(*) after a random sequence of every membership write path", async () => {
    const { conn, workspaceId, run } = await setup();
    const next = random(20261020);
    const pick = <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
    const some = <T>(items: readonly T[], max: number): T[] =>
      items.filter(() => next() < max / Math.max(1, items.length));
    const campaign = await conn.db
      .insertInto("campaigns")
      .values({ workspace_id: workspaceId, name: "Source" })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const name of ["A", "B", "C"]) await run(listsCreate, { name });
    for (const name of ["x", "y"]) await run(tagsCreate, { name });
    let serial = 0;
    const email = () => `c${serial++}@counts.test`;
    const used = new Set<string>();

    const steps: Record<string, () => Promise<unknown>> = {
      upsert: async () => {
        const address = next() < 0.3 && used.size > 0 ? (pick([...used]) ?? email()) : email();
        used.add(address);
        return run(contactsUpsert, {
          email: address,
          consentBasis: "explicit_opt_in",
          tags: some(["x", "y", "z"], 1.5),
          listIds: some(await ids(conn, "lists", workspaceId), 1.5),
        });
      },
      import: async () => {
        // The CSV import's set-based writes, in one atomic batch.
        const emails = some([...used], 6);
        const lists = some(await ids(conn, "lists", workspaceId), 1.5);
        const tags = some(await ids(conn, "tags", workspaceId), 1.5);
        return conn.atomic([
          ...subscribeContacts(conn.db, workspaceId, emails, lists, { source: "import:1", now: 1 }),
          ...tagContacts(conn.db, workspaceId, emails, tags, 1),
        ]);
      },
      addToList: async () => {
        const list = pick(await ids(conn, "lists", workspaceId));
        const contacts = some(await ids(conn, "contacts", workspaceId), 5);
        if (list === undefined || contacts.length === 0) return;
        return run(listsAddContacts, { id: list, contactIds: contacts });
      },
      removeFromList: async () => {
        const list = pick(await ids(conn, "lists", workspaceId));
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (list === undefined || contact === undefined) return;
        return run(listsRemoveContact, { id: list, contactId: contact });
      },
      addTags: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        return run(contactsAddTags, { id: contact, tags: some(["x", "y", "z"], 2).concat("x") });
      },
      removeTag: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        const tag = pick(await ids(conn, "tags", workspaceId));
        if (contact === undefined || tag === undefined) return;
        return run(contactsRemoveTag, { id: contact, tagId: tag });
      },
      unsubscribeInUi: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        return run(contactsUpdate, { id: contact, unsubscribe: true });
      },
      oneClick: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        const target = await subscription(conn, workspaceId, campaign.id, contact);
        return unsubscribeAll(conn, target, "one_click", Date.now());
      },
      resubscribe: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        const target = await subscription(conn, workspaceId, campaign.id, contact);
        return resubscribe(conn, target, Date.now());
      },
      preferences: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        const target = await subscription(conn, workspaceId, campaign.id, contact);
        const keep = new Set(
          some(
            target.lists.map((list) => list.id),
            1,
          ),
        );
        const result = await savePreferences(conn, target, keep, Date.now());
        // The returned counts are the memberships that changed, not the trigger rows.
        const leave = target.lists.filter((l) => l.status === "subscribed" && !keep.has(l.id));
        const join = target.lists.filter((l) => l.status === "unsubscribed" && keep.has(l.id));
        expect(result).toEqual({ unsubscribed: leave.length, resubscribed: join.length });
        return result;
      },
      suppress: async () => {
        const address = pick([...used]);
        if (address === undefined) return;
        return run(suppressionsAdd, { emails: [address] });
      },
      deleteContact: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        return run(contactsDelete, { id: contact });
      },
      erase: async () => {
        const contact = pick(await ids(conn, "contacts", workspaceId));
        if (contact === undefined) return;
        const row = await conn.db
          .selectFrom("contacts")
          .select("email")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", contact)
          .executeTakeFirstOrThrow();
        return run(contactsErase, { id: contact, confirm: row.email });
      },
      deleteList: async () => {
        const lists = await ids(conn, "lists", workspaceId);
        if (lists.length < 3 || next() < 0.5) return run(listsCreate, { name: `L${serial++}` });
        return run(listsDelete, { id: pick(lists) });
      },
      deleteTag: async () => {
        const tags = await ids(conn, "tags", workspaceId);
        if (tags.length < 2 || next() < 0.5) return run(tagsCreate, { name: `t${serial++}` });
        return run(tagsDelete, { id: pick(tags) });
      },
    };
    const names = Object.keys(steps);
    const done = new Set<string>();
    for (let step = 0; step < 160; step++) {
      // The first steps add contacts, so the later ones have memberships to change.
      const name = step < 12 ? "upsert" : (pick(names) as string);
      await (steps[name] as () => Promise<unknown>)();
      done.add(name);
      expect({ step, name, mismatches: await mismatches(conn, workspaceId) }).toEqual({
        step,
        name,
        mismatches: [],
      });
    }
    expect([...done].sort()).toEqual([...names].sort());

    // The API returns the stored counts.
    const lists = await run<{ items: { id: number; subscribed: number; unsubscribed: number }[] }>(
      listsList,
      {},
    );
    for (const list of lists.items) {
      const row = await sql<{ s: number; u: number }>`
SELECT sum(status = 'subscribed') AS s, sum(status = 'unsubscribed') AS u FROM list_members WHERE workspace_id = ${workspaceId} AND list_id = ${list.id}`.execute(
        conn.db,
      );
      expect([list.subscribed, list.unsubscribed]).toEqual([
        Number(row.rows[0]?.s ?? 0),
        Number(row.rows[0]?.u ?? 0),
      ]);
    }
    const tags = await run<{ items: { id: number; contacts: number }[] }>(tagsList, {});
    expect(tags.items.length).toBeGreaterThan(0);
  });

  it("reports the new memberships of a list add, not the trigger rows", async () => {
    const { conn, workspaceId, run } = await setup();
    const list = await run<{ id: number }>(listsCreate, { name: "Adds" });
    for (const address of ["a@adds.test", "b@adds.test"]) {
      await run(contactsUpsert, { email: address, consentBasis: "explicit_opt_in" });
    }
    const contacts = await ids(conn, "contacts", workspaceId);
    const first = await run<{ added: number }>(listsAddContacts, {
      id: list.id,
      contactIds: contacts,
    });
    const second = await run<{ added: number }>(listsAddContacts, {
      id: list.id,
      contactIds: contacts,
    });
    expect([first.added, second.added]).toEqual([2, 0]);
  });
});

describe("repairCounts", () => {
  it("corrects drifted counts in chunks and writes nothing when they are right", async () => {
    const { conn, workspaceId, run } = await setup();
    const lists: number[] = [];
    for (const name of ["R1", "R2", "R3"])
      lists.push((await run<{ id: number }>(listsCreate, { name })).id);
    await run(contactsUpsert, {
      email: "r@repair.test",
      consentBasis: "explicit_opt_in",
      tags: ["r"],
      listIds: lists,
    });
    expect(await repairCounts(conn, workspaceId, 2)).toEqual({ lists: 0, tags: 0 });

    await sql`UPDATE lists SET subscribed_count = 7, unsubscribed_count = 3 WHERE workspace_id = ${workspaceId}`.execute(
      conn.db,
    );
    await sql`UPDATE tags SET contact_count = 0 WHERE workspace_id = ${workspaceId}`.execute(
      conn.db,
    );
    expect((await mismatches(conn, workspaceId)).length).toBe(4);

    // A chunk of 2 lists takes two statements for three lists.
    expect(await repairCounts(conn, workspaceId, 2)).toEqual({ lists: 3, tags: 1 });
    expect(await mismatches(conn, workspaceId)).toEqual([]);
    expect(await repairCounts(conn, workspaceId, 2)).toEqual({ lists: 0, tags: 0 });
  });
});
