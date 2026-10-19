import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "./connection";
import { createWriteMeter, meterD1 } from "./metering";

async function newWorkspace(name: string): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO workspaces (name) VALUES (?) RETURNING id")
    .bind(name)
    .first<{ id: number }>();
  if (!row) throw new Error("no workspace");
  return row.id;
}

describe("metered binding", () => {
  it("reports the sum of rows_written from Kysely queries and atomic batches once per invocation", async () => {
    const metered = await newWorkspace("Metered");
    const native = await newWorkspace("Native");

    // The same writes through the plain binding give the expected total.
    let expected = 0;
    const nativeResults = [
      await env.DB.prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?)")
        .bind(native, "one")
        .run(),
      ...(await env.DB.batch([
        env.DB.prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?)").bind(native, "two"),
        env.DB.prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?)").bind(native, "three"),
      ])),
      await env.DB.prepare("UPDATE tags SET name = ? WHERE workspace_id = ? AND name = ?")
        .bind("uno", native, "one")
        .run(),
    ];
    for (const result of nativeResults) expected += result.meta.rows_written;
    expect(expected).toBeGreaterThan(0);

    const sink = vi.fn();
    const { db, atomic, meter } = createDb(env, { usageSink: sink });
    await db.insertInto("tags").values({ workspace_id: metered, name: "one" }).execute();
    await atomic([
      db.insertInto("tags").values({ workspace_id: metered, name: "two" }),
      db.insertInto("tags").values({ workspace_id: metered, name: "three" }),
    ]);
    await db
      .updateTable("tags")
      .set({ name: "uno" })
      .where("workspace_id", "=", metered)
      .where("name", "=", "one")
      .execute();
    // A read adds nothing.
    await db.selectFrom("tags").selectAll().where("workspace_id", "=", metered).execute();

    expect(meter.rowsWritten).toBe(expected);
    expect(sink).not.toHaveBeenCalled();

    await expect(meter.flush()).resolves.toBe(expected);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(expected);

    // Nothing pending: a second flush does not call the sink.
    await expect(meter.flush()).resolves.toBe(0);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(meter.rowsWritten).toBe(expected);
  });

  it("meters first() and raw(), which return no meta from the native binding", async () => {
    const workspace = await newWorkspace("FirstRaw");
    const meter = createWriteMeter();
    const d1 = meterD1(env.DB, meter);

    const row = await d1
      .prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?) RETURNING id, name")
      .bind(workspace, "first")
      .first<{ id: number; name: string }>();
    expect(row?.name).toBe("first");
    const afterFirst = meter.rowsWritten;
    expect(afterFirst).toBeGreaterThan(0);

    const name = await d1
      .prepare("SELECT name FROM tags WHERE workspace_id = ?")
      .bind(workspace)
      .first<string>("name");
    expect(name).toBe("first");
    await expect(
      d1.prepare("SELECT name FROM tags WHERE workspace_id = ?").bind(workspace).first("nope"),
    ).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
    expect(
      await d1.prepare("SELECT name FROM tags WHERE workspace_id = ?").bind(-1).first(),
    ).toBeNull();

    const raw = await d1
      .prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?) RETURNING name")
      .bind(workspace, "raw")
      .raw({ columnNames: true });
    expect(raw).toEqual([["name"], ["raw"]]);
    expect(meter.rowsWritten).toBeGreaterThan(afterFirst);
  });

  it("meters batches on a session", async () => {
    const workspace = await newWorkspace("Session");
    const meter = createWriteMeter();
    const session = meterD1(env.DB, meter).withSession();
    await session.batch([
      session.prepare("INSERT INTO tags (workspace_id, name) VALUES (?, ?)").bind(workspace, "s"),
    ]);
    expect(meter.rowsWritten).toBeGreaterThan(0);
  });

  it("keeps rows pending when the sink fails", async () => {
    const sink = vi.fn().mockRejectedValueOnce(new Error("meter down"));
    const meter = createWriteMeter(sink);
    meter.record(5);
    await expect(meter.flush()).rejects.toThrow("meter down");
    expect(meter.pending).toBe(5);
    await expect(meter.flush()).resolves.toBe(5);
    expect(sink).toHaveBeenLastCalledWith(5);
    expect(meter.pending).toBe(0);
  });

  it("ignores zero and invalid counts", () => {
    const meter = createWriteMeter();
    meter.record(0);
    meter.record(Number.NaN);
    meter.record(-3);
    expect(meter.rowsWritten).toBe(0);
  });
});
