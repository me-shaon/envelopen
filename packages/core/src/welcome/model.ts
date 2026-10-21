import type { Row, WelcomeSendStatus } from "@envelopen/db";
import { z } from "zod";

// Welcome series (U10, R15, R16, KTD8). A series is 1 to 5 emails for one list, each with
// a delay. Each contact gets one Workflow instance per series, with the id
// `welcome-<contactId>-<seriesId>`, so a contact gets each series once. The instance
// state holds only these ids, never an address, so an erase leaves no personal data in
// Workflow state.

/** A series has at most 5 steps (R15). */
export const MAX_WELCOME_STEPS = 5;
/** The longest delay before a step: 30 days, in minutes. */
export const MAX_DELAY_MINUTES = 30 * 24 * 60;
export const SERIES_NAME_MAX = 100;
export const STEP_SUBJECT_MAX = 200;

/**
 * Unsubscribe links of welcome emails use the token format of campaign recipients
 * (packages/email-render/src/tokens.ts). The campaign field holds this marker, and the
 * recipient field holds the `welcome_sends` id plus the same offset. No campaign or
 * campaign recipient reaches 2^50 rows, so the ids never meet campaign ids, and the
 * UnsubscribeLedger keeps the intents of both apart. Code that does not know the marker
 * finds no campaign recipient for such a token and changes nothing.
 */
export const WELCOME_TOKEN_CAMPAIGN = 2 ** 50;
const WELCOME_RECIPIENT_OFFSET = 2 ** 50;

export function welcomeRecipientId(sendId: number): number {
  return WELCOME_RECIPIENT_OFFSET + sendId;
}

/** The `welcome_sends` id of a token reference, or null for a campaign recipient. */
export function welcomeSendIdOf(ref: { campaignId: number; recipientId: number }): number | null {
  if (ref.campaignId !== WELCOME_TOKEN_CAMPAIGN) return null;
  const id = ref.recipientId - WELCOME_RECIPIENT_OFFSET;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The campaign id to store with an unsubscribe: null for a welcome email. */
export function storedCampaignId(campaignId: number): number | null {
  return campaignId === WELCOME_TOKEN_CAMPAIGN ? null : campaignId;
}

/** One Workflow instance: a contact in a series. Only ids (KTD8). */
export interface WelcomeJob {
  workspaceId: number;
  seriesId: number;
  contactId: number;
}

/** The Workflow instance id of a contact in a series. */
export function welcomeInstanceId(job: { seriesId: number; contactId: number }): string {
  return `welcome-${job.contactId}-${job.seriesId}`;
}

export interface WelcomeStep {
  templateId: number;
  subject: string;
  delayMinutes: number;
}

export const WelcomeStepSchema = z
  .object({
    templateId: z.number().int().positive(),
    subject: z.string().trim().min(1).max(STEP_SUBJECT_MAX).meta({
      description: "The subject line. Merge tags such as {{ first_name }} work here.",
    }),
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).meta({
      description:
        "Minutes to wait before this step: after the start for step 1, after the previous step for the others. At most 43,200 (30 days).",
    }),
  })
  .meta({ id: "WelcomeStep" });

/** Parses the stored steps. Bad items are left out, and at most 5 stay. */
export function parseSteps(json: string | null): WelcomeStep[] {
  let value: unknown;
  try {
    value = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const steps: WelcomeStep[] = [];
  for (const item of value) {
    const parsed = WelcomeStepSchema.safeParse(item);
    if (parsed.success) steps.push(parsed.data);
  }
  return steps.slice(0, MAX_WELCOME_STEPS);
}

const StepStatsSchema = z.object({
  position: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  pending: z.number().int(),
});

export const WelcomeSeriesSchema = z
  .object({
    id: z.number().int(),
    listId: z.number().int(),
    name: z.string(),
    steps: z.array(WelcomeStepSchema),
    fromName: z.string().nullable(),
    fromEmail: z.string().nullable().meta({
      description: "Null uses noreply@ the first verified sending domain.",
    }),
    replyTo: z.string().nullable(),
    enabled: z.boolean(),
    entered: z.number().int().meta({ description: "The contacts that started the series." }),
    stats: z.array(StepStatsSchema).meta({ description: "Send results per step position." }),
    overlaps: z
      .array(
        z.object({
          seriesId: z.number().int(),
          listId: z.number().int(),
          listName: z.string(),
          sharedContacts: z.number().int(),
        }),
      )
      .meta({
        description:
          "Other series whose list shares subscribed contacts with this list. A shared contact gets both series.",
      }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "WelcomeSeries" });

export type WelcomeSeries = z.input<typeof WelcomeSeriesSchema>;
export type StepStats = z.input<typeof StepStatsSchema>;
export type SeriesOverlap = WelcomeSeries["overlaps"][number];

export function toSeries(
  row: Row<"welcome_series">,
  stats: readonly StepStats[] = [],
  overlaps: readonly SeriesOverlap[] = [],
): WelcomeSeries {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    steps: parseSteps(row.steps),
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    enabled: row.enabled === 1,
    entered: row.entered_count,
    stats: [...stats],
    overlaps: [...overlaps],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The statuses that end a step for a contact. A retry never sends after one of them. */
export const FINAL_STATUSES: ReadonlySet<WelcomeSendStatus> = new Set(["sent", "skipped"]);
