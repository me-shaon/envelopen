import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { tryFinalizeCampaign } from "./finalize";
import {
  campaignSources,
  canTransitionBatch,
  canTransitionCampaign,
  transitionCampaign,
} from "./state-machine";
import { finalizeIdle } from "./sweep";

describe("campaign state machine", () => {
  it("allows the transitions of the plan's state diagram, and no others", () => {
    expect(canTransitionCampaign("draft", "scheduled", "confirm_schedule")).toBe(true);
    expect(canTransitionCampaign("scheduled", "draft", "unschedule")).toBe(true);
    expect(canTransitionCampaign("draft", "sending", "confirm_send")).toBe(true);
    expect(canTransitionCampaign("scheduled", "sending", "start_scheduled")).toBe(true);
    expect(canTransitionCampaign("sending", "paused", "pause")).toBe(true);
    expect(canTransitionCampaign("paused", "sending", "resume")).toBe(true);
    expect(canTransitionCampaign("sending", "needs_decision")).toBe(true);
    expect(canTransitionCampaign("needs_decision", "sending", "decide")).toBe(true);
    expect(canTransitionCampaign("sending", "sent")).toBe(true);
    for (const from of ["sending", "paused", "needs_decision"] as const) {
      expect(canTransitionCampaign(from, "cancelled", "cancel")).toBe(true);
    }
    expect(canTransitionCampaign("sent", "sending")).toBe(false);
    expect(canTransitionCampaign("cancelled", "sending")).toBe(false);
    expect(canTransitionCampaign("draft", "sent")).toBe(false);
    expect(canTransitionCampaign("paused", "sent")).toBe(false);
    expect(campaignSources("cancel").sort()).toEqual([
      "needs_decision",
      "paused",
      "scheduled",
      "sending",
    ]);
  });

  it("allows the batch transitions, and never sends an uncertain batch without a decision", () => {
    expect(canTransitionBatch("pending", "enqueued", "dispatch")).toBe(true);
    expect(canTransitionBatch("enqueued", "claimed", "claim")).toBe(true);
    expect(canTransitionBatch("claimed", "pending", "return")).toBe(true);
    expect(canTransitionBatch("claimed", "uncertain", "lease_expired")).toBe(true);
    expect(canTransitionBatch("claimed", "enqueued", "idempotent_retry")).toBe(true);
    expect(canTransitionBatch("uncertain", "pending", "owner_retry")).toBe(true);
    expect(canTransitionBatch("uncertain", "skipped", "owner_skip")).toBe(true);
    // Only the owner moves an uncertain batch back into the send path.
    expect(canTransitionBatch("uncertain", "enqueued")).toBe(false);
    expect(canTransitionBatch("uncertain", "claimed")).toBe(false);
    expect(canTransitionBatch("done", "pending")).toBe(false);
  });

  it("lets one of two racing compare-and-set changes win", async () => {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services);
    const id = await createDraft(db, seeded);
    await transitionCampaign(db, seeded.workspaceId, id, ["draft"], "sending", 1);
    const results = await Promise.all([
      transitionCampaign(db, seeded.workspaceId, id, ["sending"], "paused", 2),
      transitionCampaign(db, seeded.workspaceId, id, ["sending"], "cancelled", 2),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("finalize", () => {
  async function sendingCampaign(batches: ("done" | "uncertain" | "claimed")[]) {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services);
    const id = await createDraft(db, seeded);
    await db.db
      .updateTable("campaigns")
      .set({ status: "sending", snapshot_done_at: 1, started_at: 1 })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", id)
      .execute();
    for (const [index, status] of batches.entries()) {
      await db.db
        .insertInto("campaign_batches")
        .values({
          workspace_id: seeded.workspaceId,
          campaign_id: id,
          seq: index + 1,
          status,
          lease_until: null,
          recipient_set: null,
          idempotency_key: null,
          first_claimed_at: null,
          last_error: null,
          recipient_count: 1,
        })
        .execute();
    }
    return { db, seeded, id };
  }

  it("reaches sent once when the consumer and the sweep both try the transition", async () => {
    const { db, seeded, id } = await sendingCampaign(["done", "done"]);
    const deps = { db, queue: { send: async () => {} }, startCampaignJob: async () => {}, now: 10 };
    const [consumer, sweep] = await Promise.all([
      tryFinalizeCampaign(db, seeded.workspaceId, id, 10),
      finalizeIdle(deps),
    ]);
    const changes = [consumer.changed, sweep.some((item) => item.id === id)].filter(Boolean);
    expect(changes).toHaveLength(1);
    const row = await db.db
      .selectFrom("campaigns")
      .select(["status", "completed_at"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "sent", completed_at: 10 });
    // A third try changes nothing.
    expect((await tryFinalizeCampaign(db, seeded.workspaceId, id, 11)).changed).toBe(false);
  });

  it("reaches needs_decision once when a batch is uncertain, and never while one is open", async () => {
    const open = await sendingCampaign(["done", "claimed"]);
    expect((await tryFinalizeCampaign(open.db, open.seeded.workspaceId, open.id, 5)).changed).toBe(
      false,
    );

    const { db, seeded, id } = await sendingCampaign(["done", "uncertain"]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => tryFinalizeCampaign(db, seeded.workspaceId, id, 10)),
    );
    expect(results.filter((result) => result.changed)).toEqual([
      { changed: true, status: "needs_decision" },
    ]);
    const { rows } = await sql<{ status: string; completed_at: number | null }>`
SELECT status, completed_at FROM campaigns WHERE workspace_id = ${seeded.workspaceId} AND id = ${id}`.execute(
      db.db,
    );
    expect(rows[0]).toEqual({ status: "needs_decision", completed_at: null });
  });
});
