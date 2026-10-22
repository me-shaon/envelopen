// The rolling daily counter of a connection with a `daily_cap` (U19, R27, KTD14). The
// Worker keeps it in the RateLimiter Durable Object of the connection
// (apps/worker/src/do/rate-limiter.ts). Campaign batches, welcome steps, and form
// confirmation emails reserve from it before they send, so they share one cap. A
// connection without a cap does not use the counter.

/**
 * The answer of a reservation. `at` is the reservation time, for a later release.
 * `freeAt` is the first time at which the reservation fits, or null when it is larger
 * than the whole cap.
 */
export type DailyGrant = { granted: true; at: number } | { granted: false; freeAt: number | null };

export interface DailyCounter {
  /** The messages of the connection in the last 24 hours. */
  used(connectionId: number): Promise<number>;
  /** Reserves `units` messages when the last 24 hours leave room under `cap`. */
  reserve(connectionId: number, units: number, cap: number): Promise<DailyGrant>;
  /** Gives back `units` of a reservation made at `at`, because the provider sent nothing. */
  release(connectionId: number, units: number, at: number): Promise<void>;
}
