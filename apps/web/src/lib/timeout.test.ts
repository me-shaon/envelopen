import { describe, expect, it } from "vitest";
import { isTimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  it("aborts with a TimeoutError after the time", async () => {
    const signal = withTimeout(undefined, 10);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(isTimeoutError(signal.reason)).toBe(true);
  });

  it("aborts at once when the caller aborts, and the reason is not a timeout", () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 60_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(isTimeoutError(signal.reason)).toBe(false);
  });

  it("does not treat other errors as a timeout", () => {
    expect(isTimeoutError(new DOMException("stop", "AbortError"))).toBe(false);
    expect(isTimeoutError(new Error("TimeoutError"))).toBe(false);
  });
});
