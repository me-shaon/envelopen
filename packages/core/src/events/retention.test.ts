import type { DbConnection } from "@envelopen/db";
import { describe, expect, it } from "vitest";
import { createWorkspace, testDb } from "../../test/fixtures";
import { DAY_MS, purgeExpiredEvents } from "./retention";

// Retention runs per workspace (R51): each workspace keeps its raw events for its own
// period, and provider events stay at least 30 days for the soft-bounce rule (R44).

const NOW = Date.UTC(2026, 9, 20);

async function workspace(conn: DbConnection, retentionDays: number) {
  const id = await createWorkspace(conn);
  await conn.db
    .updateTable("workspaces")
    .set({ event_retention_days: retentionDays })
    .where("id", "=", id)
    .execute();
  return id;
}

async function addEvents(conn: DbConnection, workspaceId: number, ages: readonly number[]) {
  for (const days of ages) {
    const occurredAt = NOW - days * DAY_MS;
    await conn.db
      .insertInto("email_events")
      .values({
        workspace_id: workspaceId,
        campaign_id: null,
        recipient_id: null,
        contact_id: null,
        type: "open",
        link_id: null,
        provider_message_id: null,
        is_machine: 0,
        is_bot: 0,
        data: null,
        occurred_at: occurredAt,
      })
      .execute();
    await conn.db
      .insertInto("provider_events")
      .values({
        workspace_id: workspaceId,
        connection_id: null,
        provider: "resend",
        event_id: crypto.randomUUID(),
        type: "delivered",
        provider_message_id: null,
        email_hash: null,
        detail: null,
        occurred_at: occurredAt,
        processed_at: occurredAt,
      })
      .execute();
  }
}

async function ages(conn: DbConnection, workspaceId: number) {
  const of = async (table: "email_events" | "provider_events") =>
    (
      await conn.db
        .selectFrom(table)
        .select("occurred_at")
        .where("workspace_id", "=", workspaceId)
        .orderBy("occurred_at", "desc")
        .execute()
    ).map((row) => Math.round((NOW - row.occurred_at) / DAY_MS));
  return { events: await of("email_events"), provider: await of("provider_events") };
}

describe("purgeExpiredEvents", () => {
  it("deletes each workspace's events past its own retention period", async () => {
    const conn = testDb();
    const short = await workspace(conn, 30);
    const long = await workspace(conn, 365);
    await addEvents(conn, short, [1, 29, 31, 100]);
    await addEvents(conn, long, [1, 31, 100, 364, 366]);

    await purgeExpiredEvents(conn, NOW);

    expect(await ages(conn, short)).toEqual({ events: [1, 29], provider: [1, 29] });
    expect(await ages(conn, long)).toEqual({
      events: [1, 31, 100, 364],
      provider: [1, 31, 100, 364],
    });
  });

  it("deletes at most `limit` rows per table in one run, and the rest in the next", async () => {
    const conn = testDb();
    const id = await workspace(conn, 30);
    await addEvents(conn, id, [40, 41, 42, 1]);

    await purgeExpiredEvents(conn, NOW, 2);
    expect((await ages(conn, id)).events).toHaveLength(2);
    await purgeExpiredEvents(conn, NOW, 2);
    expect(await ages(conn, id)).toEqual({ events: [1], provider: [1] });
  });
});
