import {
  type BatchPointer,
  campaignsGet,
  campaignsResume,
  type DailyCounter,
  redispatchWaiting,
  runOperation,
} from "@envelopen/core";
import { describe, expect, it } from "vitest";
import {
  batchRow,
  campaignRow,
  recordingQueue,
  sendingCampaign,
  T0,
  type TestDeps,
  testDeps,
} from "../../test/campaign-helpers";
import { DAY_MS } from "../do/rate-limiter";
import { processPointer } from "./send-consumer";

// Daily caps and multi-day sends (U19, R27, R28, AE6). The consumer runs on the real
// local D1 with a provider mock (Resend: batches of 50) and a daily counter on a test
// clock. The simulation processes the queued pointers, moves the clock on, and runs the
// sweep that dispatches the batches whose window has started.

const STEP_MS = 15 * 60 * 1000;

interface Send {
  at: number;
  count: number;
}

/** The counter of the test deps, as the operations use it. */
function counterOf(deps: TestDeps): DailyCounter {
  return {
    used: async () => deps.daily.used(),
    reserve: async (_id, units, cap) => deps.daily.reserve(units, cap),
    release: async (_id, units, at) => deps.daily.release(units, at),
  };
}

/** Records the time and size of each provider call. */
function recordSends(deps: TestDeps): Send[] {
  const sends: Send[] = [];
  const respond = deps.mock.respond;
  deps.mock.respond = (call, index) => {
    const custom = respond?.(call, index);
    if (custom) return custom;
    sends.push({ at: deps.clock.now, count: call.to.length });
    return undefined;
  };
  return sends;
}

/** Runs the queue and the sweep until the clock reaches `until` or nothing is left. */
async function simulate(
  deps: TestDeps,
  workspaceId: number,
  campaignId: number,
  initial: BatchPointer[],
  until: number,
): Promise<void> {
  let queued = [...initial];
  while (deps.clock.now < until) {
    for (const pointer of queued) await processPointer(deps, pointer);
    const status = (await campaignRow(deps.db, workspaceId, campaignId)).status;
    if (status !== "sending") return;
    deps.clock.now += STEP_MS;
    const queue = recordingQueue();
    await redispatchWaiting(
      { db: deps.db, queue, startCampaignJob: async () => {}, now: deps.clock.now },
      50,
    );
    queued = queue.sent.filter((pointer) => pointer.campaignId === campaignId);
  }
}

/** The most messages in any 24-hour period. */
function maxIn24h(sends: readonly Send[]): number {
  let max = 0;
  for (const start of sends) {
    let sum = 0;
    for (const send of sends) {
      if (send.at >= start.at && send.at < start.at + DAY_MS) sum += send.count;
    }
    max = Math.max(max, sum);
  }
  return max;
}

function daysOf(sends: readonly Send[]): number[] {
  return [...new Set(sends.map((send) => Math.floor((send.at - T0) / DAY_MS)))];
}

describe("daily caps (U19)", () => {
  it("covers AE6: a cap of 500 sends 1,800 contacts over 4 days, at most 500 in any 24 hours", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      contacts: 1800,
      dailyCap: 500,
    });
    const campaign = await campaignRow(db, seeded.workspaceId, campaignId);
    expect(campaign.send_days).toBe(4);
    expect(campaign.send_window_start).toBe(T0);
    // Window 0 dispatches at once: 10 batches of 50.
    expect(pointers).toHaveLength(10);

    const deps = await testDeps(db);
    const sends = recordSends(deps);
    await simulate(deps, seeded.workspaceId, campaignId, pointers, T0 + 5 * DAY_MS);

    expect(sends.reduce((sum, send) => sum + send.count, 0)).toBe(1800);
    expect(maxIn24h(sends)).toBeLessThanOrEqual(500);
    expect(daysOf(sends)).toEqual([0, 1, 2, 3]);
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
    const detail = await runOperation(seeded.principal, campaignsGet, { id: campaignId }, { db });
    expect(detail).toMatchObject({ sendDays: 4, sendEndsAt: T0 + 3 * DAY_MS });
  });

  it("lets a welcome email mid-campaign take room from the window, and moves the end date", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      contacts: 2000,
      dailyCap: 500,
    });
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).send_days).toBe(4);
    const deps = await testDeps(db);
    const sends = recordSends(deps);
    // Window 0 has 10 batches of 50. Two go, then a welcome email reserves one message
    // from the same counter.
    expect(pointers).toHaveLength(10);
    await processPointer(deps, pointers[0] as BatchPointer);
    await processPointer(deps, pointers[1] as BatchPointer);
    expect(deps.daily.reserve(1, 500).granted).toBe(true);
    for (const pointer of pointers.slice(2, 9)) {
      expect((await processPointer(deps, pointer)).result).toBe("sent");
    }
    // The last batch does not fit (451 used): it moves to window 1.
    expect((await processPointer(deps, pointers[9] as BatchPointer)).result).toBe("daily_cap");
    const moved = await batchRow(db, seeded.workspaceId, pointers[9]?.batchId as number);
    expect(moved).toMatchObject({ status: "pending", send_window: 1 });
    expect(moved.not_before).toBeGreaterThan(T0 + DAY_MS);
    // The later batches shift with it: the campaign needs a fifth day.
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).send_days).toBe(5);
    const detail = await runOperation(seeded.principal, campaignsGet, { id: campaignId }, { db });
    expect(detail.sendEndsAt).toBe(T0 + 4 * DAY_MS);

    await simulate(deps, seeded.workspaceId, campaignId, [], T0 + 6 * DAY_MS);
    expect(sends.reduce((sum, send) => sum + send.count, 0)).toBe(2000);
    // The welcome email counts as well: campaign sends plus it stay under the cap.
    expect(maxIn24h([...sends, { at: T0 + 1000, count: 1 }])).toBeLessThanOrEqual(500);
    expect(daysOf(sends)).toEqual([0, 1, 2, 3, 4]);
  });

  it("pauses at a provider quota mid-window, and resume shows the shifted end date", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      contacts: 1500,
      dailyCap: 500,
    });
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).send_days).toBe(3);
    const deps = await testDeps(db);
    await processPointer(deps, pointers[0] as BatchPointer);
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "daily_quota_exceeded", message: "Quota" }), {
        status: 429,
      });
    expect((await processPointer(deps, pointers[1] as BatchPointer)).result).toBe("returned");
    const paused = await campaignRow(db, seeded.workspaceId, campaignId);
    expect(paused).toMatchObject({ status: "paused", pause_reason: "provider_quota" });
    // The quota fills the counter: nothing else sends through it today.
    expect(deps.daily.used()).toBe(500);

    deps.mock.respond = undefined;
    deps.clock.now += 60 * 60 * 1000;
    const queue = recordingQueue();
    await runOperation(
      seeded.principal,
      campaignsResume,
      { id: campaignId },
      {
        db,
        services: { sendQueue: queue, dailyCounter: counterOf(deps) },
        now: () => deps.clock.now,
      },
    );
    // 1,450 recipients are left. Window 0 has no room, so they need windows 1 to 3.
    const resumed = await runOperation(seeded.principal, campaignsGet, { id: campaignId }, { db });
    expect(resumed).toMatchObject({ status: "sending", sendDays: 4 });
    expect(resumed.sendEndsAt).toBe(T0 + 3 * DAY_MS);
    expect(queue.sent.filter((pointer) => pointer.campaignId === campaignId)).toEqual([]);

    const sends = recordSends(deps);
    await simulate(deps, seeded.workspaceId, campaignId, [], T0 + 5 * DAY_MS);
    expect(sends.reduce((sum, send) => sum + send.count, 0)).toBe(1450);
    expect(daysOf(sends)).toEqual([1, 2, 3]);
    expect(maxIn24h(sends)).toBeLessThanOrEqual(500);
  });

  it("applies a lower cap after confirm to the later windows", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      contacts: 1000,
      dailyCap: 500,
    });
    const deps = await testDeps(db);
    const sends = recordSends(deps);
    for (const pointer of pointers) await processPointer(deps, pointer);
    await db.db
      .updateTable("provider_connections")
      .set({ daily_cap: 300 })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.connectionId)
      .execute();
    await simulate(deps, seeded.workspaceId, campaignId, [], T0 + 4 * DAY_MS);
    expect(sends.reduce((sum, send) => sum + send.count, 0)).toBe(1000);
    const later = sends.filter((send) => send.at >= T0 + DAY_MS);
    expect(maxIn24h(later)).toBeLessThanOrEqual(300);
    expect(daysOf(sends)).toEqual([0, 1, 2]);
  });

  it("keeps today's behavior without a cap", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 1800 });
    expect(pointers).toHaveLength(36);
    const campaign = await campaignRow(db, seeded.workspaceId, campaignId);
    expect(campaign).toMatchObject({ send_days: null, send_window_start: null });
    const deps = await testDeps(db);
    for (const pointer of pointers)
      expect((await processPointer(deps, pointer)).result).toBe("sent");
    expect(deps.daily.used()).toBe(0);
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });
});
