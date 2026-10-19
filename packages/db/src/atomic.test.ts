import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { chunkedInsert, D1_MAX_BOUND_PARAMETERS } from "./atomic";
import { createDb } from "./connection";
import { WorkspaceScopeError } from "./workspace-scope";

const { db, atomic, meter } = createDb(env, { enforceWorkspaceScope: true });

let workspaceId = 0;

beforeEach(async () => {
  const row = await db
    .insertInto("workspaces")
    .values({ name: "Atomic" })
    .returning("id")
    .executeTakeFirstOrThrow();
  workspaceId = row.id;
});

async function tagCount(): Promise<number> {
  const row = await db
    .selectFrom("tags")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return row.n;
}

const tag = (name: string) => db.insertInto("tags").values({ workspace_id: workspaceId, name });

describe("atomic", () => {
  it("commits all rows of a group of three inserts", async () => {
    const results = await atomic([tag("a"), tag("b"), tag("c")]);
    expect(results).toHaveLength(3);
    expect(await tagCount()).toBe(3);
  });

  it("leaves no rows when one statement in the group fails", async () => {
    // The third insert breaks UNIQUE (workspace_id, name).
    await expect(atomic([tag("a"), tag("b"), tag("a")])).rejects.toThrow();
    expect(await tagCount()).toBe(0);
  });

  it("returns an empty result for an empty group and calls no D1 batch", async () => {
    const before = meter.rowsWritten;
    await expect(atomic([])).resolves.toEqual([]);
    expect(meter.rowsWritten).toBe(before);
  });

  it("accepts compiled queries and returns rows from RETURNING", async () => {
    const results = await atomic<{ name: string }>([
      tag("x").returning("name").compile(),
      db.selectFrom("tags").select("name").where("workspace_id", "=", workspaceId),
    ]);
    expect(results[0]?.results).toEqual([{ name: "x" }]);
    expect(results[1]?.results).toEqual([{ name: "x" }]);
  });

  it("checks workspace scope before it sends the batch", async () => {
    const unscopedDelete = db.deleteFrom("tags");
    await expect(atomic([tag("a"), unscopedDelete])).rejects.toThrow(WorkspaceScopeError);
    expect(await tagCount()).toBe(0);
  });
});

describe("chunkedInsert", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ workspace_id: workspaceId, name: `t${i}` }));

  const parameterCounts = (queries: { compile(): { parameters: readonly unknown[] } }[]) =>
    queries.map((q) => q.compile().parameters.length);

  it("returns no queries for no rows", () => {
    expect(chunkedInsert(db, "tags", [])).toEqual([]);
  });

  it("keeps exactly 100 bound parameters in one chunk, and D1 accepts it", async () => {
    // Two columns per row: 50 rows use exactly 100 parameters.
    const queries = chunkedInsert(db, "tags", rows(50));
    expect(parameterCounts(queries)).toEqual([D1_MAX_BOUND_PARAMETERS]);
    await atomic(queries);
    expect(await tagCount()).toBe(50);
  });

  it("splits at 101 parameters", () => {
    expect(parameterCounts(chunkedInsert(db, "tags", rows(51)))).toEqual([100, 2]);
  });

  it("splits a multi-row insert above 100 parameters into chunks and inserts every row", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      workspace_id: workspaceId,
      name: `t${i}`,
      created_at: 1_700_000_000_000 + i,
    }));
    const queries = chunkedInsert(db, "tags", many);
    // Three columns per row: 33 rows (99 parameters) per chunk.
    expect(parameterCounts(queries)).toEqual([99, 99, 99, 3]);
    await atomic(queries);
    expect(await tagCount()).toBe(100);
  });

  it("counts parameters that modify() adds", () => {
    const queries = chunkedInsert(db, "tags", rows(60), {
      modify: (q) =>
        q.onConflict((oc) => oc.columns(["workspace_id", "name"]).doUpdateSet({ created_at: 1 })),
    });
    // One fixed parameter (created_at = 1) leaves 99 for rows: 49 rows of 2 columns.
    expect(parameterCounts(queries)).toEqual([99, 23]);
  });

  it("sizes chunks by the union of columns when rows differ", () => {
    const mixed = [
      { workspace_id: workspaceId, name: "a" },
      { workspace_id: workspaceId, name: "b", created_at: 1 },
      ...rows(60).map((r) => ({ ...r, name: `m${r.name}` })),
    ];
    const queries = chunkedInsert(db, "tags", mixed);
    for (const count of parameterCounts(queries)) expect(count).toBeLessThanOrEqual(100);
    expect(queries).toHaveLength(2);
  });

  it("rejects a row that alone needs more parameters than the limit", () => {
    expect(() => chunkedInsert(db, "tags", rows(1), { maxParameters: 1 })).toThrow(
      /more than the limit/,
    );
  });
});
