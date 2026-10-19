import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, createWorkspace, testDb } from "../../test/fixtures";
import { runOperation } from "../executor";
import {
  workspacesArchive,
  workspacesCreate,
  workspacesList,
  workspacesRename,
} from "../registry/operations/workspaces";
import { ALL_SCOPES } from "../scopes";
import { resolveSessionPrincipal } from "./membership";

describe("session principal", () => {
  it("uses the oldest active workspace, or the requested one", async () => {
    const conn = testDb();
    const userId = await createUser(conn);
    const first = await createOwnedWorkspace(conn, userId, "First");
    const second = await createOwnedWorkspace(conn, userId, "Second");

    const fallback = await resolveSessionPrincipal(conn, userId, undefined);
    expect(fallback).toMatchObject({
      workspaceId: first,
      actorType: "user",
      actorId: userId,
      surface: "ui",
      apiKeyId: null,
    });
    expect([...fallback.scopes].sort()).toEqual([...ALL_SCOPES].sort());
    expect((await resolveSessionPrincipal(conn, userId, String(second))).workspaceId).toBe(second);
  });

  it("rejects a workspace that the user is not a member of, or an archived one", async () => {
    const conn = testDb();
    const userId = await createUser(conn);
    await createOwnedWorkspace(conn, userId);
    const foreign = await createWorkspace(conn, "Foreign");
    await expect(resolveSessionPrincipal(conn, userId, String(foreign))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(resolveSessionPrincipal(conn, userId, "1; DROP")).rejects.toMatchObject({
      code: "invalid_input",
    });

    const archived = await createOwnedWorkspace(conn, userId, "Old");
    await conn.db
      .updateTable("workspaces")
      .set({ archived_at: 1 })
      .where("id", "=", archived)
      .execute();
    await expect(resolveSessionPrincipal(conn, userId, String(archived))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects a user without an active workspace, and a non-owner role", async () => {
    const conn = testDb();
    const lonely = await createUser(conn);
    await expect(resolveSessionPrincipal(conn, lonely, undefined)).rejects.toMatchObject({
      code: "forbidden",
    });

    const editor = await createUser(conn);
    const workspaceId = await createWorkspace(conn);
    await conn.db
      .insertInto("workspace_members")
      .values({ workspace_id: workspaceId, user_id: editor, role: "editor" })
      .execute();
    await expect(resolveSessionPrincipal(conn, editor, undefined)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("workspace operations", () => {
  async function owner() {
    const conn = testDb();
    const userId = await createUser(conn);
    const workspaceId = await createOwnedWorkspace(conn, userId, "Main");
    return {
      conn,
      userId,
      principal: await resolveSessionPrincipal(conn, userId, undefined),
      workspaceId,
    };
  }

  it("creates a workspace with the owner as member, in one batch", async () => {
    const { conn, userId, principal } = await owner();
    const created = await runOperation(
      principal,
      workspacesCreate,
      { name: "  New  " },
      { db: conn },
    );
    expect(created.name).toBe("New");
    const member = await conn.db
      .selectFrom("workspace_members")
      .select(["user_id", "role"])
      .where("workspace_id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ user_id: userId, role: "owner" });
    expect((await resolveSessionPrincipal(conn, userId, String(created.id))).workspaceId).toBe(
      created.id,
    );
  });

  it("renames, lists, and archives, but never the last active workspace", async () => {
    const { conn, principal, workspaceId } = await owner();
    await expect(
      runOperation(principal, workspacesArchive, { id: workspaceId }, { db: conn }),
    ).rejects.toMatchObject({ code: "conflict" });

    const other = await runOperation(principal, workspacesCreate, { name: "Other" }, { db: conn });
    const renamed = await runOperation(
      principal,
      workspacesRename,
      { id: other.id, name: "Renamed" },
      { db: conn },
    );
    expect(renamed.name).toBe("Renamed");
    const archived = await runOperation(
      principal,
      workspacesArchive,
      { id: other.id },
      { db: conn, now: () => 5 },
    );
    expect(archived.archivedAt).toBe(5);
    // Archiving again changes nothing.
    const again = await runOperation(
      principal,
      workspacesArchive,
      { id: other.id },
      { db: conn, now: () => 9 },
    );
    expect(again.archivedAt).toBe(5);

    const list = await runOperation(principal, workspacesList, {}, { db: conn });
    expect(list.items.map((item) => [item.name, item.archivedAt])).toEqual([
      ["Main", null],
      ["Renamed", 5],
    ]);
  });

  it("rejects an empty name and a foreign workspace", async () => {
    const { conn, principal } = await owner();
    await expect(
      runOperation(principal, workspacesCreate, { name: "   " }, { db: conn }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const foreign = await createWorkspace(conn, "Foreign");
    await expect(
      runOperation(principal, workspacesRename, { id: foreign, name: "x" }, { db: conn }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      runOperation(principal, workspacesArchive, { id: foreign }, { db: conn }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
