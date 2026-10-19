import { describe, expect, it } from "vitest";
import { isD1DailyLimitError, nextUtcMidnight } from "./limits";

describe("D1 daily limit", () => {
  it("recognizes the daily limit error, also when wrapped", () => {
    const error = new Error("D1_ERROR: Your daily limits have been exceeded.");
    expect(isD1DailyLimitError(error)).toBe(true);
    expect(isD1DailyLimitError(new Error("step failed", { cause: error }))).toBe(true);
    expect(isD1DailyLimitError(new Error("D1_ERROR: UNIQUE constraint failed"))).toBe(false);
    expect(isD1DailyLimitError("nope")).toBe(false);
  });

  it("finds the next reset at 00:00 UTC", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 9, 19, 23, 59))).toBe(Date.UTC(2026, 9, 20));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 0, 0))).toBe(Date.UTC(2027, 0, 1));
  });
});
