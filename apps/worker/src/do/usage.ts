import type { PlatformLimit, UsageReader, UsageStatus } from "@envelopen/core";
import type { UsageSink } from "@envelopen/db";

// Clients of the UsageMeter Durable Object (do/usage-meter.ts). They live apart from
// the class, so modules that Node.js also loads (the OpenAPI script) do not import
// `cloudflare:workers`.

/** Rows written per UTC day on Workers Free. */
export const D1_DAILY_WRITE_LIMIT = 100_000;
export const USAGE_METER_NAME = "global";

export function usageMeter(env: Pick<Env, "USAGE_METER">) {
  return env.USAGE_METER.getByName(USAGE_METER_NAME);
}

/** The reader that operations get as `services.usage`. */
export function usageReader(env: Pick<Env, "USAGE_METER">): UsageReader {
  return { status: () => usageMeter(env).status() };
}

/** The sink for `createDb`: the meter reports its rows to the Durable Object. */
export function usageSink(env: Pick<Env, "USAGE_METER">): UsageSink {
  return (rows) => usageMeter(env).record(rows);
}

/** The flag when it is still in force, or null. */
export function activeLimit(status: UsageStatus, now: number): PlatformLimit | null {
  return status.platformLimit && status.platformLimit.until > now ? status.platformLimit : null;
}
