import { describe, expect, it } from "vitest";
import { createWorkspace, testDb } from "../test/fixtures";
import { OperationError } from "./errors";
import { decodeCursor, encodeCursor, pageParams, toPage } from "./pagination";

async function insertContacts(
  conn: ReturnType<typeof testDb>,
  workspaceId: number,
  from: number,
  count: number,
) {
  const now = Date.now();
  await conn.db
    .insertInto("contacts")
    .values(
      Array.from({ length: count }, (_, index) => ({
        workspace_id: workspaceId,
        email: `c${from + index}@example.com`,
        consent_basis: "explicit_opt_in" as const,
        consent_source: "test",
        consent_at: now,
        source: "test",
      })),
    )
    .execute();
}

describe("cursor pagination", () => {
  it("round-trips a cursor and keeps it opaque", () => {
    const cursor = encodeCursor(1234);
    expect(cursor).not.toContain("1234");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe(1234);
  });

  it("rejects a cursor that Envelopen did not make", () => {
    for (const cursor of ["not-a-cursor", "e30", encodeCursor(-1), btoa('{"id":"1"}')]) {
      expect(() => decodeCursor(cursor), cursor).toThrow(OperationError);
    }
  });

  it("returns each contact once while new contacts are inserted", async () => {
    const conn = testDb();
    const workspaceId = await createWorkspace(conn);
    const otherWorkspaceId = await createWorkspace(conn, "Other");
    await insertContacts(conn, workspaceId, 0, 7);

    const seen: number[] = [];
    let cursor: string | undefined;
    let inserted = 7;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const { afterId, take } = pageParams({ cursor, limit: 3 });
      let query = conn.db
        .selectFrom("contacts")
        .select(["id"])
        .where("workspace_id", "=", workspaceId);
      if (afterId !== null) query = query.where("id", ">", afterId);
      const rows = await query.orderBy("id", "asc").limit(take).execute();
      const page = toPage(
        rows,
        3,
        (row) => row.id,
        (row) => row.id,
      );
      seen.push(...page.items);

      // New contacts arrive between pages, in this workspace and in another one.
      if (inserted < 12) {
        await insertContacts(conn, workspaceId, inserted, 2);
        await insertContacts(conn, otherWorkspaceId, 1000 + inserted, 1);
        inserted += 2;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const all = await conn.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all.map((row) => row.id));
    expect(seen.length).toBe(inserted);
  });

  it("returns no cursor on the last page", () => {
    const page = toPage(
      [{ id: 1 }, { id: 2 }],
      2,
      (row) => row.id,
      (row) => row,
    );
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], nextCursor: null });
  });
});
