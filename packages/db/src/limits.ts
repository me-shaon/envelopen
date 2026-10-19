// Free-tier daily limit (KTD24). After 100,000 rows written in a UTC day, D1 rejects
// queries until 00:00 UTC. The D1 docs say the error says that "your daily limits have
// been exceeded", but they do not give the exact text, so the match is loose.

const DAILY_LIMIT_PATTERN = /daily limit|limits? (have|has) been exceeded|exceeded.{0,40}daily/i;

/** True when a D1 error says that the daily Free-plan limit is reached. */
export function isD1DailyLimitError(error: unknown): boolean {
  let current: unknown = error;
  // D1 errors can arrive wrapped, for example by Kysely or by a Workflow step.
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (DAILY_LIMIT_PATTERN.test(current.message)) return true;
    current = current.cause;
  }
  return typeof current === "string" && DAILY_LIMIT_PATTERN.test(current);
}

/** The next 00:00 UTC after `now`, when the D1 daily limits reset. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
