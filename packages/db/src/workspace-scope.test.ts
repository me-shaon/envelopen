import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./connection";
import { TABLE_SCOPE } from "./schema";
import { unscoped, WorkspaceScopeError } from "./workspace-scope";

const { db } = createDb(env, { enforceWorkspaceScope: true });

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, name) VALUES (1, 'One')").run();
});

describe("workspace-scope plugin", () => {
  it("fails a tenant-table select without a workspace_id condition", () => {
    expect(() => db.selectFrom("contacts").selectAll().compile()).toThrow(WorkspaceScopeError);
  });

  it("fails at execution too, before the query reaches D1", async () => {
    await expect(db.selectFrom("contacts").selectAll().execute()).rejects.toThrow(
      WorkspaceScopeError,
    );
  });

  it("passes a tenant-table select with a workspace_id condition and runs it", async () => {
    const rows = await db
      .selectFrom("contacts")
      .selectAll()
      .where("workspace_id", "=", 1)
      .where("email", "=", "nobody@example.com")
      .execute();
    expect(rows).toEqual([]);
  });

  it("passes a qualified workspace_id and an IN condition", () => {
    expect(() =>
      db.selectFrom("contacts as c").selectAll().where("c.workspace_id", "in", [1, 2]).compile(),
    ).not.toThrow();
  });

  it("passes a query on a global table without a condition", async () => {
    await expect(db.selectFrom("users").selectAll().execute()).resolves.toBeDefined();
    expect(() => db.selectFrom("workspaces").selectAll().compile()).not.toThrow();
    expect(() => db.selectFrom("system_settings").selectAll().compile()).not.toThrow();
  });

  it("fails when an OR branch has no workspace_id condition", () => {
    expect(() =>
      db
        .selectFrom("contacts")
        .selectAll()
        .where((eb) => eb.or([eb("workspace_id", "=", 1), eb("email", "=", "a@example.com")]))
        .compile(),
    ).toThrow(WorkspaceScopeError);
  });

  it("passes when every OR branch has a workspace_id condition", () => {
    expect(() =>
      db
        .selectFrom("contacts")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb("workspace_id", "=", 1), eb("email", "=", "a@example.com")]),
            eb("workspace_id", "=", 2),
          ]),
        )
        .compile(),
    ).not.toThrow();
  });

  it("fails a workspace_id condition that does not restrict the workspace", () => {
    expect(() =>
      db.selectFrom("contacts").selectAll().where("workspace_id", "is not", null).compile(),
    ).toThrow(WorkspaceScopeError);
  });

  it("checks joined tenant tables", () => {
    const joined = db
      .selectFrom("workspaces")
      .innerJoin("contacts", "contacts.workspace_id", "workspaces.id")
      .selectAll("contacts");
    expect(() => joined.compile()).toThrow(WorkspaceScopeError);
    expect(() => joined.where("contacts.workspace_id", "=", 1).compile()).not.toThrow();
  });

  it("does not count a column-to-column workspace_id match as a scope", () => {
    const joined = db
      .selectFrom("contacts")
      .innerJoin("list_members", (join) =>
        join
          .onRef("list_members.contact_id", "=", "contacts.id")
          .onRef("list_members.workspace_id", "=", "contacts.workspace_id"),
      )
      .selectAll("contacts");
    expect(() => joined.compile()).toThrow(WorkspaceScopeError);
    expect(() => joined.where("contacts.workspace_id", "=", 1).compile()).not.toThrow();
  });

  it("checks subqueries on their own", () => {
    expect(() =>
      db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "in", (eb) => eb.selectFrom("contacts").select("workspace_id"))
        .compile(),
    ).toThrow(WorkspaceScopeError);
  });

  it("checks update and delete", () => {
    expect(() => db.updateTable("contacts").set({ first_name: "A" }).compile()).toThrow(
      WorkspaceScopeError,
    );
    expect(() => db.deleteFrom("tags").where("id", "=", 1).compile()).toThrow(WorkspaceScopeError);
    expect(() =>
      db.deleteFrom("tags").where("workspace_id", "=", 1).where("id", "=", 1).compile(),
    ).not.toThrow();
  });

  it("requires workspace_id in tenant-table inserts", () => {
    const values = { name: "vip" } as unknown as { workspace_id: number; name: string };
    expect(() => db.insertInto("tags").values(values).compile()).toThrow(WorkspaceScopeError);
    expect(() =>
      db.insertInto("tags").values({ workspace_id: 1, name: "vip" }).compile(),
    ).not.toThrow();
  });

  it("checks raw SQL by the table names it mentions", async () => {
    await expect(sql`SELECT * FROM contacts`.execute(db)).rejects.toThrow(WorkspaceScopeError);
    await expect(
      sql`SELECT * FROM contacts WHERE workspace_id = ${1}`.execute(db),
    ).resolves.toBeDefined();
    await expect(sql`SELECT * FROM users`.execute(db)).resolves.toBeDefined();
  });

  it("lets unscoped() run a deliberate cross-workspace query", async () => {
    await expect(unscoped(db).selectFrom("contacts").selectAll().execute()).resolves.toEqual([]);
  });

  it("is off unless enabled", () => {
    const plain = createDb(env).db;
    expect(() => plain.selectFrom("contacts").selectAll().compile()).not.toThrow();
  });
});

describe("schema", () => {
  it("has exactly the tables that the Database interface declares", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(Object.keys(TABLE_SCOPE).sort());
  });

  it("has workspace_id on every tenant table and not on global tables", async () => {
    for (const [table, scope] of Object.entries(TABLE_SCOPE)) {
      const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`)
        .bind(table)
        .all<{ name: string }>();
      const hasWorkspaceId = results.some((c) => c.name === "workspace_id");
      expect({ table, hasWorkspaceId }).toEqual({ table, hasWorkspaceId: scope === "tenant" });
    }
  });
});
