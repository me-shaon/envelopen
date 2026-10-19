import type { Schemas } from "@/api/client";
import type { Tone } from "@/components/ui/pill";

// Labels that the usage page and the sidebar card share.

export type Usage = Schemas["Usage"];
export type UsageState = Usage["d1Writes"]["state"];

export const USAGE_STATE: Record<UsageState, { label: string; tone: Tone }> = {
  ok: { label: "Within the limit", tone: "teal" },
  warning: { label: "Above 80%", tone: "salmon" },
  limit: { label: "Limit reached", tone: "danger" },
};

const utcClock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** A time of day in UTC, for example "00:00 UTC". */
export function formatUtcClock(ms: number): string {
  return `${utcClock.format(new Date(ms))} UTC`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

/** A large count in short form, for example "100K". */
export function formatCompact(value: number): string {
  return compact.format(value);
}
