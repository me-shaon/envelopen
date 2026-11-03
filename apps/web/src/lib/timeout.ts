/** The caller's signal and a timeout, as one signal. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener("abort", () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

/** True for the error of a fetch that a timeout signal stopped. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
