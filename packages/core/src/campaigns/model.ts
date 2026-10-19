import type { BatchStatus, Bool, CampaignStatus, DbConnection, Row } from "@envelopen/db";
import { z } from "zod";
import { parseJson } from "../connections/model";
import { OperationError } from "../errors";

// The campaign read model and the engine's constants (U9). The engine follows the
// state diagram in the plan: campaigns move between draft, scheduled, sending, paused,
// needs_decision, sent, and cancelled. Batches move between pending, enqueued, claimed,
// done, uncertain, and skipped (state-machine.ts).

export type CampaignRow = Row<"campaigns">;
export type BatchRow = Row<"campaign_batches">;

/** A confirm token works for this long after prepare (R68). */
export const CONFIRM_TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * A claimed batch must have its results within this time (KTD18). It covers the slowest
 * send: 25 SES calls, 5 at a time, each with a 15 second timeout, is 75 seconds.
 */
export const LEASE_MS = 5 * 60 * 1000;
/**
 * A batch that stays enqueued this long is dispatched again with a new generation
 * (KTD19). It is long enough that a normal queue backlog on Free does not trigger it.
 */
export const ENQUEUE_TIMEOUT_MS = 30 * 60 * 1000;
/** A batch that the provider rate-limited waits this long when the provider gave no time. */
export const DEFAULT_RETRY_DELAY_MS = 60 * 1000;
/** An idempotent provider retries a batch at most this many times, then it is uncertain. */
export const IDEMPOTENT_ATTEMPT_LIMIT = 5;
/** The snapshot reads this many contacts per Workflow step (KTD22). */
export const SNAPSHOT_PAGE_CONTACTS = 1000;
/** At most this many targeted or excluded lists and tags, so the queries stay under 100 parameters. */
export const AUDIENCE_MAX_IDS = 10;

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "paused",
  "needs_decision",
  "sent",
  "cancelled",
] as const satisfies readonly CampaignStatus[];

export const BATCH_STATUSES = [
  "pending",
  "enqueued",
  "claimed",
  "done",
  "uncertain",
  "skipped",
] as const satisfies readonly BatchStatus[];

export const PAUSE_REASONS = [
  "manual",
  "platform_limit",
  "provider_quota",
  "provider_credits",
] as const;

/** Why the snapshot or the send-time check left a contact out (AE1, AE2, KTD21). */
export const EXCLUSION_REASONS = ["consent_unknown", "suppressed", "unsubscribed"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export type ExclusionCounts = Record<ExclusionReason, number>;

export function emptyExclusions(): ExclusionCounts {
  return { consent_unknown: 0, suppressed: 0, unsubscribed: 0 };
}

const ids = z.array(z.number().int().positive()).max(AUDIENCE_MAX_IDS);

export const AudienceSchema = z
  .object({
    listIds: ids.default([]).meta({ description: "Subscribed members of these lists." }),
    tagIds: ids.default([]).meta({ description: "Contacts with any of these tags." }),
    excludeListIds: ids
      .default([])
      .meta({ description: "Leave out members of these lists, subscribed or not." }),
    excludeTagIds: ids.default([]).meta({ description: "Leave out contacts with these tags." }),
  })
  .meta({ id: "CampaignAudience" });

export type Audience = z.output<typeof AudienceSchema>;

export function parseAudience(text: string | null): Audience {
  const parsed = AudienceSchema.safeParse(parseJson<unknown>(text, {}));
  return parsed.success
    ? parsed.data
    : { listIds: [], tagIds: [], excludeListIds: [], excludeTagIds: [] };
}

/**
 * The audience rules of one campaign. A follow-up (R35) also keeps to the contacts that
 * got its parent and did not open it as a person (follow-up.ts).
 */
export type CampaignAudience = Audience & { followUpOf?: number | null };

export function campaignAudience(
  row: Pick<CampaignRow, "audience" | "parent_id">,
): CampaignAudience {
  return { ...parseAudience(row.audience), followUpOf: row.parent_id };
}

export function isAudienceEmpty(audience: Audience): boolean {
  return audience.listIds.length === 0 && audience.tagIds.length === 0;
}

const ExclusionsSchema = z
  .object({
    consent_unknown: z.number().int(),
    suppressed: z.number().int(),
    unsubscribed: z.number().int(),
  })
  .meta({ id: "CampaignExclusions" });

export const CampaignProgressSchema = z
  .object({
    total: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    pending: z.number().int().meta({ description: "Not sent yet, and not uncertain." }),
    uncertain: z
      .number()
      .int()
      .meta({ description: "In uncertain batches: they may or may not have been sent." }),
    batches: z.record(z.enum(BATCH_STATUSES), z.number().int()),
  })
  .meta({ id: "CampaignProgress" });

export type CampaignProgress = z.output<typeof CampaignProgressSchema>;

export const CampaignSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    parentId: z.number().int().nullable().meta({
      description:
        "For a follow-up: the campaign whose non-openers it targets (R35). Null otherwise.",
    }),
    type: z.enum(["regular", "re-permission"]).meta({
      description: "Only a re-permission campaign includes contacts whose consent is unknown.",
    }),
    status: z.enum(CAMPAIGN_STATUSES),
    pauseReason: z.enum(PAUSE_REASONS).nullable(),
    pauseDetail: z.string().nullable(),
    pausedAt: z.number().int().nullable(),
    resumeAt: z
      .number()
      .int()
      .nullable()
      .meta({ description: "For a platform_limit pause: when sending resumes (after 00:00 UTC)." }),
    version: z.number().int().meta({ description: "Each edit increments it." }),
    templateId: z.number().int().nullable(),
    subject: z.string().nullable(),
    preheader: z.string().nullable(),
    fromName: z.string().nullable(),
    fromEmail: z.string().nullable(),
    replyTo: z.string().nullable(),
    hasContent: z.boolean(),
    audience: AudienceSchema,
    trackOpens: z.boolean(),
    trackClicks: z.boolean(),
    scheduledAt: z.number().int().nullable(),
    startedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
    recipientCount: z.number().int().nullable(),
    exclusions: ExclusionsSchema.nullable(),
    snapshotDone: z.boolean(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "Campaign" });

export type Campaign = z.input<typeof CampaignSchema>;

export const CampaignDetailSchema = CampaignSchema.extend({
  progress: CampaignProgressSchema,
  provider: z
    .object({ connectionId: z.number().int(), provider: z.string(), name: z.string() })
    .nullable(),
}).meta({ id: "CampaignDetail" });

export function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    type: row.type,
    status: row.status,
    pauseReason: row.pause_reason,
    pauseDetail: row.pause_detail,
    pausedAt: row.paused_at,
    resumeAt: row.resume_at,
    version: row.version,
    templateId: row.template_id,
    subject: row.subject,
    preheader: row.preheader,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    hasContent: Boolean(row.html),
    audience: parseAudience(row.audience),
    trackOpens: row.tracking_opens === 1,
    trackClicks: row.tracking_clicks === 1,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    recipientCount: row.recipient_count,
    exclusions: row.exclusions
      ? parseJson<ExclusionCounts>(row.exclusions, emptyExclusions())
      : null,
    snapshotDone: row.snapshot_done_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadCampaign(
  db: DbConnection,
  workspaceId: number,
  id: number,
): Promise<CampaignRow> {
  const row = await db.db
    .selectFrom("campaigns")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The campaign does not exist.");
  return row;
}

/** Whether open and click tracking applies to a send. */
export interface SendTracking {
  opens: boolean;
  clicks: boolean;
}

type TrackingSwitches = { tracking_opens: number; tracking_clicks: number };

/**
 * The tracking of a send from the campaign and workspace switches: it applies only when
 * both are on. Confirm stores the result on the campaign.
 */
export function combineTracking(
  campaign: TrackingSwitches,
  workspace: TrackingSwitches,
): { send_tracking_opens: Bool; send_tracking_clicks: Bool } {
  return {
    send_tracking_opens: campaign.tracking_opens === 1 && workspace.tracking_opens === 1 ? 1 : 0,
    send_tracking_clicks: campaign.tracking_clicks === 1 && workspace.tracking_clicks === 1 ? 1 : 0,
  };
}

/**
 * The tracking that applied to the campaign's send, as stored at confirm. Before
 * confirm, it is the tracking that a send would get now.
 */
export async function sendTracking(db: DbConnection, campaign: CampaignRow): Promise<SendTracking> {
  let stored = {
    send_tracking_opens: campaign.send_tracking_opens,
    send_tracking_clicks: campaign.send_tracking_clicks,
  };
  if (stored.send_tracking_opens === null || stored.send_tracking_clicks === null) {
    const workspace = await db.db
      .selectFrom("workspaces")
      .select(["tracking_opens", "tracking_clicks"])
      .where("id", "=", campaign.workspace_id)
      .executeTakeFirst();
    stored = combineTracking(campaign, workspace ?? { tracking_opens: 0, tracking_clicks: 0 });
  }
  return { opens: stored.send_tracking_opens === 1, clicks: stored.send_tracking_clicks === 1 };
}

/** Recipient and batch counts of a campaign, summed over its batches (not its recipients). */
export async function campaignProgress(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
): Promise<CampaignProgress> {
  const rows = await db.db
    .selectFrom("campaign_batches")
    .select((eb) => [
      "status",
      eb.fn.countAll<number>().as("batches"),
      eb.fn.sum<number>("recipient_count").as("recipients"),
      eb.fn.sum<number>("sent_count").as("sent"),
      eb.fn.sum<number>("failed_count").as("failed"),
      eb.fn.sum<number>("skipped_count").as("skipped"),
    ])
    .where("workspace_id", "=", workspaceId)
    .where("campaign_id", "=", campaignId)
    .groupBy("status")
    .execute();
  const progress: CampaignProgress = {
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    uncertain: 0,
    batches: Object.fromEntries(BATCH_STATUSES.map((status) => [status, 0])) as Record<
      BatchStatus,
      number
    >,
  };
  for (const row of rows) {
    const recipients = Number(row.recipients ?? 0);
    const sent = Number(row.sent ?? 0);
    const failed = Number(row.failed ?? 0);
    const skipped = Number(row.skipped ?? 0);
    const open = Math.max(0, recipients - sent - failed - skipped);
    progress.total += recipients;
    progress.sent += sent;
    progress.failed += failed;
    progress.skipped += skipped;
    progress.batches[row.status] = Number(row.batches);
    if (row.status === "uncertain") progress.uncertain += open;
    // An owner-skipped uncertain batch has no open recipients left: they count as skipped.
    else if (row.status !== "skipped") progress.pending += open;
  }
  return progress;
}
