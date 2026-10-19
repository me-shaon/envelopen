import { describe, expect, it } from "vitest";
import {
  type SentCampaign,
  seedCampaignWorkspace,
  seedSentCampaign,
} from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { isOperationError } from "../errors";
import { flushEvents } from "../events/flush";
import type { TrackingEvent } from "../events/model";
import { runOperation } from "../executor";
import type { CampaignStats } from "../stats/campaign-stats";
import { campaignsStats } from "../stats/operations";
import { checkBatchRecipients } from "./audience";
import { campaignsFollowUp } from "./follow-up";
import { campaignAudience, loadCampaign } from "./model";
import { campaignsConfirm, campaignsEstimate, campaignsPrepare } from "./operations";
import { beginSnapshot, snapshotPage } from "./snapshot";

// Follow-up to non-openers (R35): a child campaign that leaves out human openers, keeps
// machine-only openers, and goes through prepare and confirm. It is unavailable when the
// parent was sent without open tracking.

const T0 = Date.UTC(2026, 9, 19, 9);
const LATER = T0 + 24 * 60 * 60 * 1000;

async function setup(options: { trackOpens?: boolean } = {}) {
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, { contacts: 4 });
  const parent = await seedSentCampaign(db, seeded, {
    startedAt: T0,
    trackOpens: options.trackOpens,
  });
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = LATER) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => now }) as Promise<T>;
  return { db, services, seeded, parent, run };
}

function open(sent: SentCampaign, index: number, at: number, machine = false): TrackingEvent {
  const recipient = sent.recipients[index];
  if (!recipient) throw new Error(`No recipient ${index}.`);
  return {
    source: "tracking",
    type: "open",
    campaignId: sent.campaignId,
    recipientId: recipient.id,
    contactId: recipient.contactId,
    linkId: null,
    machine,
    bot: false,
    reason: machine ? "asn" : null,
    occurredAt: at,
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOperationError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

describe("follow-up to non-openers", () => {
  it("excludes human openers, includes machine-only openers, and sends through prepare and confirm", async () => {
    const { db, services, seeded, parent, run } = await setup();
    // Contact 0 opened as a person. Contact 1 has machine opens only. Contact 2 has no
    // open. Contact 3 had a machine open, then opened as a person.
    await flushEvents(
      db,
      seeded.workspaceId,
      [
        open(parent, 0, T0 + 60_000),
        open(parent, 1, T0 + 30_000, true),
        open(parent, 1, T0 + 90_000, true),
        open(parent, 3, T0 + 30_000, true),
        open(parent, 3, T0 + 600_000),
      ],
      T0 + 700_000,
    );

    const child = await run<{ id: number; parentId: number | null; status: string; name: string }>(
      campaignsFollowUp,
      { id: parent.campaignId },
    );
    expect(child).toMatchObject({
      parentId: parent.campaignId,
      status: "draft",
      name: "Course launch (follow-up)",
    });
    const estimate = await run<{ recipients: number }>(campaignsEstimate, { id: child.id });
    expect(estimate.recipients).toBe(2);

    // The normal prepare and confirm.
    const prepared = await run<{ token: string | null; estimate: { recipients: number } }>(
      campaignsPrepare,
      { id: child.id, mode: "send_now" },
    );
    expect(prepared.estimate.recipients).toBe(2);
    expect(prepared.token).not.toBeNull();
    await run(campaignsConfirm, { id: child.id, token: prepared.token }, LATER + 1000);
    expect(services.campaignJobs.at(-1)).toMatchObject({ campaignId: child.id });

    const job = { workspaceId: seeded.workspaceId, campaignId: child.id, startedAt: LATER + 1000 };
    const begin = await beginSnapshot(db, job);
    if (begin.state === "stop") throw new Error(begin.reason);
    const page = await snapshotPage(
      db,
      services.sendQueue,
      job,
      { afterId: 0, cut: begin.cut, batchSize: begin.batchSize },
      LATER + 2000,
    );
    expect(page).toMatchObject({ kind: "page", recipients: 2 });
    const recipients = await db.db
      .selectFrom("campaign_recipients")
      .select(["contact_id", "batch_id"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("campaign_id", "=", child.id)
      .orderBy("contact_id")
      .execute();
    expect(recipients.map((row) => row.contact_id)).toEqual([
      parent.recipients[1]?.contactId,
      parent.recipients[2]?.contactId,
    ]);

    // Contact 2 opens the first email after the snapshot. The send-time check skips it.
    await flushEvents(db, seeded.workspaceId, [open(parent, 2, LATER + 3000)], LATER + 4000);
    const row = await loadCampaign(db, seeded.workspaceId, child.id);
    const checked = await checkBatchRecipients(
      db,
      seeded.workspaceId,
      child.id,
      recipients[0]?.batch_id ?? 0,
      campaignAudience(row),
      row.type,
    );
    expect(checked.map((item) => [item.contactId, item.skipReason])).toEqual([
      [parent.recipients[1]?.contactId, null],
      [parent.recipients[2]?.contactId, "opened"],
    ]);
  });

  it("is unavailable for a campaign sent with open tracking off", async () => {
    const { parent, run } = await setup({ trackOpens: false });
    expect(await failure(run(campaignsFollowUp, { id: parent.campaignId }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Open tracking was off"),
    });
    const stats = await run<CampaignStats>(campaignsStats, { id: parent.campaignId });
    expect(stats.followUp).toEqual({
      available: false,
      reason: expect.stringContaining("Open tracking was off"),
    });
    expect(stats.rates.open).toBeNull();
  });

  it("is unavailable when the workspace had open tracking off and no open was recorded", async () => {
    const { db, seeded, parent, run } = await setup();
    await db.db
      .updateTable("workspaces")
      .set({ tracking_opens: 0 })
      .where("id", "=", seeded.workspaceId)
      .execute();
    expect(await failure(run(campaignsFollowUp, { id: parent.campaignId }))).toMatchObject({
      code: "conflict",
    });
  });

  it("is available on the stats of a campaign with open tracking", async () => {
    const { parent, run } = await setup();
    const stats = await run<CampaignStats>(campaignsStats, { id: parent.campaignId });
    expect(stats.followUp).toEqual({ available: true, reason: null });
  });

  it("waits until the parent has finished sending", async () => {
    const { db, seeded, parent, run } = await setup();
    await db.db
      .updateTable("campaigns")
      .set({ status: "sending" })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", parent.campaignId)
      .execute();
    expect(await failure(run(campaignsFollowUp, { id: parent.campaignId }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("finished sending"),
    });
  });
});
