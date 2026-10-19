import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BatchPointer,
  beginSnapshot,
  emptyExclusions,
  finishSnapshot,
  snapshotPage,
} from "@envelopen/core";
import {
  addContacts,
  bulkContacts,
  createDraft,
  seedCampaignWorkspace,
} from "@envelopen/core/testing/campaign-fixtures";
import { createProviderMock, type ProviderMock } from "@envelopen/core/testing/provider-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  campaignDb,
  campaignRow,
  recipientRows,
  recordingQueue,
  T0,
  testKeys,
} from "../../test/campaign-helpers";
import { campaignInstanceId } from "../services";

// The campaign Workflow end to end, in the local runtime: the real Workflow takes the
// snapshot and puts the pointers on the real send queue, and the real queue consumer
// sends each batch. The consumer's outbound fetch goes to a provider mock.

let mock: ProviderMock;

beforeEach(() => {
  mock = createProviderMock();
  vi.spyOn(globalThis, "fetch").mockImplementation(mock.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Seeds, confirms straight to sending, and starts the real Workflow. */
async function start(options: {
  contacts?: number;
  bulk?: number;
  unknown?: number;
  type?: "regular" | "re-permission";
}) {
  const db = campaignDb();
  const keys = await testKeys();
  const seeded = await seedCampaignWorkspace(db, keys, { contacts: options.contacts ?? 0 });
  if (options.unknown) {
    await addContacts(db, keys.hashEmail, seeded.workspaceId, seeded.listId, options.unknown, {
      consent: "unknown",
      prefix: "old",
    });
  }
  if (options.bulk) await bulkContacts(db, seeded.workspaceId, seeded.listId, options.bulk);
  // A high account rate, so the rate limiter does not slow the test.
  await db.db
    .updateTable("provider_connections")
    .set({ provider_refs: JSON.stringify({ maxSendRate: "10000" }) })
    .where("workspace_id", "=", seeded.workspaceId)
    .where("id", "=", seeded.connectionId)
    .execute();
  const campaignId = await createDraft(db, seeded, { type: options.type ?? "regular" });
  const startedAt = Date.now();
  await db.db
    .updateTable("campaigns")
    .set({
      status: "sending",
      started_at: startedAt,
      connection_id: seeded.connectionId,
      link_origin: "https://envelopen.test",
    })
    .where("workspace_id", "=", seeded.workspaceId)
    .where("id", "=", campaignId)
    .execute();
  const job = { workspaceId: seeded.workspaceId, campaignId, startedAt };
  const introspector = await introspectWorkflow(env.CAMPAIGN_WORKFLOW);
  try {
    await env.CAMPAIGN_WORKFLOW.create({ id: campaignInstanceId(job), params: job });
    const [instance] = await introspector.get();
    await instance?.waitForStatus("complete");
  } finally {
    await introspector.dispose();
  }
  return { db, seeded, campaignId };
}

describe("campaign Workflow", () => {
  it("covers AE1: a regular campaign leaves out unknown consent with the reason, a re-permission campaign includes it", async () => {
    const regular = await start({ contacts: 3, unknown: 2 });
    const done = await waitFor(
      () => campaignRow(regular.db, regular.seeded.workspaceId, regular.campaignId),
      (row) => row.status === "sent",
      15_000,
    );
    expect(done).toMatchObject({ status: "sent", recipient_count: 3 });
    expect(JSON.parse(done.exclusions ?? "{}")).toEqual({
      consent_unknown: 2,
      suppressed: 0,
      unsubscribed: 0,
    });
    const emails = (
      await recipientRows(regular.db, regular.seeded.workspaceId, regular.campaignId)
    ).map((row) => row.email);
    expect(emails.some((email) => email.startsWith("old"))).toBe(false);

    const repermission = await start({ contacts: 3, unknown: 2, type: "re-permission" });
    const sent = await waitFor(
      () => campaignRow(repermission.db, repermission.seeded.workspaceId, repermission.campaignId),
      (row) => row.status === "sent",
      15_000,
    );
    expect(sent).toMatchObject({ status: "sent", recipient_count: 5 });
    expect(JSON.parse(sent.exclusions ?? "{}")).toEqual(emptyExclusions());
  });

  it("covers F1: a campaign of 5,000 recipients sends each recipient exactly once, also with redelivered messages", async () => {
    const { db, seeded, campaignId } = await start({ bulk: 5000 });
    const done = await waitFor(
      () => campaignRow(db, seeded.workspaceId, campaignId),
      (row) => row.status === "sent",
      120_000,
    );
    expect(done).toMatchObject({ status: "sent", recipient_count: 5000 });

    // At-least-once delivery: every batch's message arrives once more.
    const batches = await db.db
      .selectFrom("campaign_batches")
      .select(["id", "generation", "status"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("campaign_id", "=", campaignId)
      .execute();
    expect(batches).toHaveLength(100);
    expect(batches.every((batch) => batch.status === "done")).toBe(true);
    const duplicates: BatchPointer[] = batches.map((batch) => ({
      v: 1,
      workspaceId: seeded.workspaceId,
      campaignId,
      batchId: batch.id,
      generation: batch.generation,
    }));
    for (let i = 0; i < duplicates.length; i += 100) {
      await env.SEND_QUEUE.sendBatch(duplicates.slice(i, i + 100).map((body) => ({ body })));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const delivered = mock.delivered;
    expect(delivered).toHaveLength(5000);
    expect(new Set(delivered).size).toBe(5000);
    const statuses = await db.db
      .selectFrom("campaign_recipients")
      .select((eb) => ["status", eb.fn.countAll<number>().as("n")])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("campaign_id", "=", campaignId)
      .groupBy("status")
      .execute();
    expect(statuses.map((row) => ({ ...row, n: Number(row.n) }))).toEqual([
      { status: "sent", n: 5000 },
    ]);
  }, 180_000);

  it("never sends to a contact imported after the snapshot's cut", async () => {
    const db = campaignDb();
    const keys = await testKeys();
    const seeded = await seedCampaignWorkspace(db, keys, { contacts: 3 });
    const campaignId = await createDraft(db, seeded);
    await db.db
      .updateTable("campaigns")
      .set({
        status: "sending",
        started_at: T0,
        connection_id: seeded.connectionId,
        link_origin: "https://envelopen.test",
      })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", campaignId)
      .execute();
    const job = { workspaceId: seeded.workspaceId, campaignId, startedAt: T0 };
    const begin = await beginSnapshot(db, job);
    if (begin.state === "stop") throw new Error(begin.reason);
    // The import lands after the cut, before any page runs.
    await addContacts(db, keys.hashEmail, seeded.workspaceId, seeded.listId, 2, { prefix: "late" });
    const queue = recordingQueue();
    let afterId = 0;
    for (let page = 0; page < 10; page++) {
      const outcome = await snapshotPage(db, queue, job, { ...begin, afterId, pageSize: 2 }, T0);
      if (outcome.kind === "stop") throw new Error(outcome.reason);
      afterId = outcome.nextAfterId;
      if (outcome.done) break;
    }
    await finishSnapshot(db, job, emptyExclusions(), T0);
    const emails = (await recipientRows(db, seeded.workspaceId, campaignId)).map(
      (row) => row.email,
    );
    expect(emails.sort()).toEqual([
      "student1@example.org",
      "student2@example.org",
      "student3@example.org",
    ]);
    // Small pages still group recipients into whole batches, and every batch went on the queue.
    expect(queue.sent.length).toBeGreaterThan(0);
  });
});
