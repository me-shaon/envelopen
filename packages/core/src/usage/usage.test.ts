import { describe, expect, it } from "vitest";
import { createWorkspace, testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { sessionPrincipal } from "../principal";
import { WORKERS_PLAN_SETTING } from "../settings/operations";
import { reservedThreshold, WELCOME_RESERVE_RATIO, welcomeReserve } from "./limits";
import { usageGet } from "./operations";
import { PAID_HINT, type UsageView, usageView } from "./view";

// The usage view (R4, R71, KTD24): the measured D1 writes, the reset time, a warning at
// 80%, and the Workers Paid hint near the limit.

const NOW = Date.UTC(2026, 9, 19, 15, 30);
const MIDNIGHT = Date.UTC(2026, 9, 20);

function status(
  rowsWritten: number,
  platformLimit: { since: number; until: number } | null = null,
) {
  return { day: "2026-10-19", rowsWritten, dailyLimit: 100_000, platformLimit };
}

describe("usage view", () => {
  it("shows a warning at 80% of the measured D1 writes", () => {
    const below = usageView(status(79_999), NOW);
    expect(below.warning).toBe(false);
    expect(below.d1Writes).toMatchObject({ used: 79_999, remaining: 20_001, state: "ok" });
    expect(below.paidHint).toBeNull();

    const at = usageView(status(80_000), NOW);
    expect(at.warning).toBe(true);
    expect(at.d1Writes).toMatchObject({ used: 80_000, remaining: 20_000, state: "warning" });
    expect(at.d1Writes.ratio).toBe(0.8);
    expect(at.paidHint).toBe(PAID_HINT);
  });

  it("shows the reset at 00:00 UTC and the pause while D1 rejects writes", () => {
    const view = usageView(status(100_250, { since: NOW - 60_000, until: MIDNIGHT }), NOW);
    expect(view.resetsAt).toBe(MIDNIGHT);
    expect(view.d1Writes).toMatchObject({ remaining: 0, state: "limit" });
    expect(view.platformLimit).toEqual({ since: NOW - 60_000, until: MIDNIGHT });
    // An old flag that the cron has not cleared yet is not in force.
    expect(usageView(status(10, { since: 1, until: NOW - 1 }), NOW).platformLimit).toBeNull();
  });

  it("lists the other Free limits as not measured", () => {
    const view = usageView(status(1200), NOW);
    expect(view.limits.find((limit) => limit.id === "d1_writes")).toMatchObject({
      measured: true,
      used: 1200,
    });
    const others = view.limits.filter((limit) => limit.id !== "d1_writes");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((limit) => !limit.measured && limit.used === null)).toBe(true);
  });

  it("reads the UsageMeter through the operation", async () => {
    const db = testDb();
    const services = await testServices();
    services.usageStatus = status(85_000);
    const workspaceId = await createWorkspace(db);
    const view = (await runOperation(
      sessionPrincipal({ workspaceId, userId: "owner" }),
      usageGet,
      {},
      { db, services, now: () => NOW },
    )) as UsageView;
    expect(view.warning).toBe(true);
    expect(view.d1Writes.remaining).toBe(15_000);
  });

  it("shows the reserved threshold and the welcome share on Free", () => {
    const view = usageView({ ...status(72_000), automationRows: 4_500 }, NOW);
    expect(view.workersPlan).toBe("free");
    expect(view.reserveRatio).toBe(0.7);
    expect(view.d1Writes).toMatchObject({ reserved: 70_000, automation: 4_500, state: "ok" });
    // The automation share never passes the total.
    expect(usageView({ ...status(10), automationRows: 50 }, NOW).d1Writes.automation).toBe(10);
  });

  it("gives no threshold, no warning, and no Paid hint on Paid", () => {
    const view = usageView(status(95_000), NOW, "paid");
    expect(view.workersPlan).toBe("paid");
    expect(view.d1Writes).toMatchObject({ reserved: null, state: "ok" });
    expect(view.warning).toBe(false);
    expect(view.paidHint).toBeNull();
    // A rejected write is still a limit.
    const limited = usageView(status(10, { since: NOW - 1, until: MIDNIGHT }), NOW, "paid");
    expect(limited.d1Writes.state).toBe("limit");
    expect(limited.paidHint).toBeNull();
  });

  it("reads the Workers plan setting through the operation", async () => {
    const db = testDb();
    const services = await testServices();
    services.usageStatus = status(85_000);
    const workspaceId = await createWorkspace(db);
    await db.db
      .insertInto("system_settings")
      .values({ key: WORKERS_PLAN_SETTING, value: "paid", updated_at: NOW })
      .execute();
    try {
      const view = (await runOperation(
        sessionPrincipal({ workspaceId, userId: "owner" }),
        usageGet,
        {},
        { db, services, now: () => NOW },
      )) as UsageView;
      expect(view.workersPlan).toBe("paid");
      expect(view.d1Writes.reserved).toBeNull();
    } finally {
      await db.db.deleteFrom("system_settings").where("key", "=", WORKERS_PLAN_SETTING).execute();
    }
  });
});

describe("welcome reserve (KTD9, R17)", () => {
  it("defers a welcome step from 70% of the daily writes on Free", () => {
    expect(WELCOME_RESERVE_RATIO).toBe(0.7);
    expect(reservedThreshold(100_000)).toBe(70_000);
    expect(welcomeReserve("free", 69_999, 100_000)).toBe("ok");
    expect(welcomeReserve("free", 70_000, 100_000)).toBe("defer");
    expect(welcomeReserve("free", 120_000, 100_000)).toBe("defer");
  });

  it("never defers on Paid", () => {
    expect(welcomeReserve("paid", 70_000, 100_000)).toBe("ok");
    expect(welcomeReserve("paid", 5_000_000, 100_000)).toBe("ok");
  });
});
