import type { Schemas } from "@/api/client";
import { Pill, type Tone } from "@/components/ui/pill";
import { formatInZone } from "@/lib/timezone";

// Labels that the campaign pages share.

export type Campaign = Schemas["Campaign"];
export type CampaignStatus = Campaign["status"];
export type PauseReason = NonNullable<Campaign["pauseReason"]>;

const STATUS: Record<CampaignStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "lavender" },
  sending: { label: "Sending", tone: "teal" },
  paused: { label: "Paused", tone: "salmon" },
  needs_decision: { label: "Needs a decision", tone: "danger" },
  sent: { label: "Sent", tone: "teal" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  const item = STATUS[status];
  return <Pill tone={item.tone}>{item.label}</Pill>;
}

export const PAUSE_REASONS: Record<PauseReason, string> = {
  manual: "Paused by you",
  platform_limit: "D1 reached its daily write limit on Workers Free",
  provider_quota: "The provider's sending quota is used up",
  provider_credits: "The provider account has no credits left",
};

export const EXCLUSION_LABELS: Record<keyof Schemas["CampaignExclusions"], string> = {
  consent_unknown: "Consent unknown: they get only a re-permission campaign",
  suppressed: "Suppressed: a bounce, a complaint, or a manual block",
  unsubscribed: "Unsubscribed from the targeted lists",
};

export const CAMPAIGN_TYPES = {
  regular: {
    label: "Regular",
    detail: "Contacts whose consent is unknown are left out.",
  },
  "re-permission": {
    label: "Re-permission",
    detail: "Asks contacts with unknown consent to confirm. Includes them.",
  },
} as const;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const utcTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatWhen(ms: number | null | undefined): string {
  return ms == null ? "-" : dateTime.format(new Date(ms));
}

/**
 * The time of a schedule. With the timezone that the owner picked, it shows in that
 * zone with its name: "Oct 21, 09:00 Asia/Dhaka". Without one (a schedule from the API
 * that gave only the UTC time), it shows in the browser's time as before.
 */
export function formatScheduled(
  ms: number | null | undefined,
  timezone: string | null | undefined,
): string {
  if (ms == null) return "-";
  if (!timezone) return formatWhen(ms);
  try {
    return formatInZone(ms, timezone);
  } catch {
    // The browser does not know the zone. The browser's time is still correct.
    return formatWhen(ms);
  }
}

const dayOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The date of a time, without the time of day. */
export function formatDay(ms: number): string {
  return dayOnly.format(new Date(ms));
}

/** One sending day of a connection with a daily cap (U19). */
export const SEND_DAY_MS = 24 * 60 * 60 * 1000;

export function formatUtc(ms: number): string {
  return `${utcTime.format(new Date(ms))} UTC`;
}
