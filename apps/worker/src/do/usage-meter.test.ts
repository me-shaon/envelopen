import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { busyDay } from "../../test/campaign-helpers";
import { formDeps } from "../forms/deps";
import { activeLimit, usageMeter } from "./usage";

// The UsageMeter budget order (KTD9, R17). Welcome steps ask `reserve` and wait from 70%
// of the daily D1 writes on Workers Free. Confirmation emails and campaigns read only the
// platform_limit flag, so they stop only when D1 rejects writes.

const NOW = Date.UTC(2026, 9, 21, 15);
const NEXT_DAY = Date.UTC(2026, 9, 22, 0, 6);

function testMeter() {
  return env.USAGE_METER.getByName(`test:${crypto.randomUUID()}`);
}

describe("UsageMeter reserve", () => {
  it("defers a welcome step from 70% of the day's writes on Free, and allows it after the reset", async () => {
    const meter = testMeter();
    await meter.record(69_999, NOW);
    expect(await meter.reserve("free", NOW)).toBe("ok");
    await meter.record(1, NOW);
    expect(await meter.reserve("free", NOW)).toBe("defer");
    // The count starts again at 00:00 UTC.
    expect(await meter.reserve("free", NEXT_DAY)).toBe("ok");
  });

  it("never defers on Paid", async () => {
    const meter = testMeter();
    await meter.record(99_000, NOW);
    expect(await meter.reserve("paid", NOW)).toBe("ok");
    await meter.record(50_000, NOW);
    expect(await meter.reserve("paid", NOW)).toBe("ok");
  });

  it("counts automation writes in the day's total and in their own count", async () => {
    const meter = testMeter();
    await meter.record(100, NOW);
    await meter.recordAutomation(40, NOW);
    await meter.recordAutomation(-3, NOW);
    expect(await meter.status(NOW)).toMatchObject({ rowsWritten: 140, automationRows: 40 });
    expect(await meter.status(NEXT_DAY)).toMatchObject({ rowsWritten: 0, automationRows: 0 });
  });
});

describe("confirmation emails past the threshold", () => {
  let restore: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await restore?.();
    restore = undefined;
    await usageMeter(env).clearPlatformLimit();
  });

  it("are not limited past 70%, and stop only at the platform limit", async () => {
    restore = await busyDay(85_000);
    const meter = usageMeter(env);
    expect(await meter.reserve("free")).toBe("defer");
    const deps = formDeps(env, new Request("https://envelopen.test/f/form"));
    expect((await deps.usage()).limited).toBe(false);

    const now = Date.now();
    await meter.setPlatformLimit(now, now + 60_000);
    expect(activeLimit(await meter.status(), now)).not.toBeNull();
    expect((await deps.usage()).limited).toBe(true);
  });
});
