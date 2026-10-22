import { describe, expect, it } from "vitest";
import { createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { packWindows, planSendDays } from "./caps";
import { SEND_DAY_MS } from "./model";
import { campaignsConfirm, campaignsGet, campaignsPrepare } from "./operations";

// The sending days of a capped connection (U19, R28, AE6): the window packing, and the
// days that prepare and confirm show. The consumer and the rolling counter have their
// tests in apps/worker/src/queue/daily-cap.test.ts.

const T0 = Date.UTC(2026, 9, 19, 12);

describe("window packing", () => {
  it("covers AE6: a cap of 500 and 1,800 recipients gives 4 sending days", () => {
    expect(planSendDays(1800, { first: 500, cap: 500 }, 50)).toBe(4);
    expect(planSendDays(2000, { first: 500, cap: 500 }, 50)).toBe(4);
    expect(planSendDays(2001, { first: 500, cap: 500 }, 50)).toBe(5);
  });

  it("gives window 0 only the room that the last 24 hours leave", () => {
    // 300 sent in the last 24 hours: window 0 takes 200, then 500 a day.
    expect(planSendDays(1800, { first: 200, cap: 500 }, 50)).toBe(5);
    // No room at all: window 0 sends nothing, and the rest starts on day 2.
    expect(planSendDays(500, { first: 0, cap: 500 }, 50)).toBe(2);
    expect(planSendDays(10, { first: 500, cap: 500 }, 50)).toBe(1);
  });

  it("never puts more than the capacity in a window", () => {
    const batches = [40, 50, 50, 30, 50, 50, 50].map((count, seq) => ({ seq, count }));
    const windows = packWindows(batches, { window: 0, used: 0 }, { first: 100, cap: 120 });
    expect(windows).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });

  it("puts a batch larger than the cap alone in a full window", () => {
    const windows = packWindows(
      [
        { seq: 1, count: 30 },
        { seq: 2, count: 80 },
      ],
      { window: 0, used: 0 },
      { first: 50, cap: 50 },
    );
    expect(windows).toEqual([0, 1]);
  });
});

async function setup(dailyCap: number | null, contacts: number) {
  const db = testDb();
  const services = await testServices();
  services.dailyClock.now = T0;
  const seeded = await seedCampaignWorkspace(db, services, { contacts, dailyCap });
  const campaignId = await createDraft(db, seeded);
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = T0) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => now }) as Promise<T>;
  return { db, services, seeded, campaignId, run };
}

interface Prepared {
  token: string | null;
  sendPlan: { dailyCap: number; usedLast24h: number; days: number; endsAt: number } | null;
}

describe("prepare and confirm with a daily cap", () => {
  it("covers AE6: shows 4 sending days and the end date for 1,800 contacts at 500 a day", async () => {
    const { run, campaignId } = await setup(500, 1800);
    const prepared = await run<Prepared>(campaignsPrepare, { id: campaignId, mode: "send_now" });
    expect(prepared.sendPlan).toEqual({
      dailyCap: 500,
      usedLast24h: 0,
      days: 4,
      endsAt: T0 + 3 * SEND_DAY_MS,
    });
    const confirmed = await run<{ sendDays: number; sendEndsAt: number }>(campaignsConfirm, {
      id: campaignId,
      token: prepared.token,
    });
    expect(confirmed).toMatchObject({ sendDays: 4, sendEndsAt: T0 + 3 * SEND_DAY_MS });
    const detail = await run<{ sendWindowStart: number }>(campaignsGet, { id: campaignId });
    expect(detail.sendWindowStart).toBe(T0);
  });

  it("counts the sends of the last 24 hours against the first day", async () => {
    const { run, campaignId, services, seeded } = await setup(500, 1800);
    await services.dailyCounter.reserve(seeded.connectionId, 300, 500);
    const prepared = await run<Prepared>(campaignsPrepare, { id: campaignId, mode: "send_now" });
    expect(prepared.sendPlan).toMatchObject({ usedLast24h: 300, days: 5 });
  });

  it("shows no sending days without a cap", async () => {
    const { run, campaignId } = await setup(null, 3);
    const prepared = await run<Prepared>(campaignsPrepare, { id: campaignId, mode: "send_now" });
    expect(prepared.sendPlan).toBeNull();
    const confirmed = await run<{ sendDays: number | null }>(campaignsConfirm, {
      id: campaignId,
      token: prepared.token,
    });
    expect(confirmed.sendDays).toBeNull();
  });
});
