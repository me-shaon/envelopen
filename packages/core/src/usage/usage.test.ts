import { describe, expect, it } from "vitest";
import { createWorkspace, testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { sessionPrincipal } from "../principal";
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
});
