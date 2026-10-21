import { describe, expect, it } from "vitest";
import {
  ambiguityNote,
  formatInZone,
  instantToWallTime,
  isTimeZone,
  timeZones,
  wallTimeToInstant,
} from "./timezone";

// R8, KTD4: the owner picks a wall time in an IANA zone, and the app stores the UTC
// instant. The clock changes in America/New_York in 2026 are on March 8 (02:00 becomes
// 03:00) and November 1 (02:00 becomes 01:00).

const NOW = Date.UTC(2026, 9, 21);

describe("wallTimeToInstant", () => {
  it("converts 09:00 in Asia/Dhaka to 03:00 UTC and shows it in the zone", () => {
    const result = wallTimeToInstant("2026-10-21T09:00", "Asia/Dhaka");
    expect(result).toEqual({ ok: true, instant: Date.UTC(2026, 9, 21, 3), ambiguous: null });
    if (!result.ok) return;
    expect(formatInZone(result.instant, "Asia/Dhaka", { now: NOW, locale: "en-US" })).toBe(
      "Oct 21, 09:00 Asia/Dhaka",
    );
    expect(instantToWallTime(result.instant, "Asia/Dhaka")).toBe("2026-10-21T09:00");
  });

  it("rejects 02:30 on the spring-forward day in America/New_York with a hint", () => {
    const result = wallTimeToInstant("2026-03-08T02:30", "America/New_York");
    expect(result).toMatchObject({ ok: false, reason: "gap" });
    if (result.ok) return;
    expect(result.message).toContain("does not exist in America/New_York");
    expect(result.message).toContain("03:30");
  });

  it("picks the first 01:30 on the fall-back day and labels it", () => {
    const result = wallTimeToInstant("2026-11-01T01:30", "America/New_York");
    // The first 01:30 is EDT (UTC-4): 05:30 UTC. The second is EST: 06:30 UTC.
    expect(result).toEqual({
      ok: true,
      instant: Date.UTC(2026, 10, 1, 5, 30),
      ambiguous: { first: -4 * 3600_000, second: -5 * 3600_000 },
    });
    expect(ambiguityNote("2026-11-01T01:30", "America/New_York")).toBe(
      "01:30 happens twice in America/New_York on that day, because the clocks move back. " +
        "Envelopen uses the first one (UTC-04:00).",
    );
    expect(
      formatInZone(Date.UTC(2026, 10, 1, 5, 30), "America/New_York", {
        now: NOW,
        locale: "en-US",
      }),
    ).toBe("Nov 1, 01:30 America/New_York (UTC-04:00)");
  });

  it("gives no note for a time that happens once", () => {
    expect(ambiguityNote("2026-11-01T03:30", "America/New_York")).toBeNull();
  });

  it("converts the times next to a clock change", () => {
    expect(wallTimeToInstant("2026-03-08T01:59", "America/New_York")).toMatchObject({
      instant: Date.UTC(2026, 2, 8, 6, 59),
    });
    expect(wallTimeToInstant("2026-03-08T03:00", "America/New_York")).toMatchObject({
      instant: Date.UTC(2026, 2, 8, 7, 0),
    });
    // A zone with a 30 minute offset and no daylight saving time.
    expect(wallTimeToInstant("2026-10-21T09:00", "Asia/Kolkata")).toMatchObject({
      instant: Date.UTC(2026, 9, 21, 3, 30),
    });
  });

  it("rejects an unknown zone and an impossible date", () => {
    expect(wallTimeToInstant("2026-10-21T09:00", "Mars/Olympus_Mons")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(wallTimeToInstant("2026-02-30T09:00", "UTC")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(isTimeZone("+06:00")).toBe(false);
  });

  it("shows the year when it is not the current year", () => {
    expect(formatInZone(Date.UTC(2027, 0, 5, 3), "Asia/Dhaka", { now: NOW, locale: "en-US" })).toBe(
      "Jan 5, 2027, 09:00 Asia/Dhaka",
    );
  });
});

describe("timeZones", () => {
  it("lists IANA zones with UTC", () => {
    const zones = timeZones();
    expect(zones).toContain("Asia/Dhaka");
    expect(zones).toContain("UTC");
  });
});
