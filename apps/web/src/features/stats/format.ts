import type { Schemas } from "@/api/client";

// Number formats that the stats and usage views share.

export type CampaignStats = Schemas["CampaignStats"];

const number = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatCount(value: number): string {
  return number.format(value);
}

/** A share from 0 to 1 as a percentage, or a dash when there is no base. */
export function formatRate(value: number | null | undefined): string {
  return value == null ? "-" : percent.format(value);
}

/** The width of a hairline bar for a share, from 0 to 100. */
export function barWidth(value: number | null | undefined): number {
  return value == null ? 0 : Math.max(0, Math.min(100, value * 100));
}

export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
