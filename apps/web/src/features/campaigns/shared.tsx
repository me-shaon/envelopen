import type { Schemas } from "@/api/client";
import { Pill, type Tone } from "@/components/ui/pill";

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

export function formatUtc(ms: number): string {
  return `${utcTime.format(new Date(ms))} UTC`;
}

/** The value for a datetime-local input, in local time. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
