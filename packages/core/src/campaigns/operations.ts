import type { DbConnection, RowUpdate } from "@envelopen/db";
import { getAdapter } from "@envelopen/providers";
import { sql } from "kysely";
import { z } from "zod";
import { assertNoRestoreHold } from "../backup/restore-ack";
import { campaignBrand, liveBrand } from "../brand/model";
import { assertCampaignPolicy } from "../connections/policy-gate";
import { normalizeEmail } from "../contacts/email";
import { checkLists, checkTags } from "../contacts/writes";
import { OperationError } from "../errors";
import { decodeCursor, encodeCursor, pageInputShape, pageOf } from "../pagination";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { getTemplateRow } from "../templates/operations";
import {
  contactValues,
  personalizePreview,
  testLinkOrigin,
  verifiedTrackingDomain,
} from "../templates/preview";
import { estimateAudience } from "./audience";
import { ChecklistItemSchema, runChecklist } from "./checklist";
import { confirmError, consumeConfirmToken, issueConfirmToken } from "./confirm-token";
import { dispatchAll, dispatchBatches } from "./dispatch";
import { tryFinalizeCampaign } from "./finalize";
import {
  type Audience,
  AudienceSchema,
  BATCH_STATUSES,
  CampaignDetailSchema,
  type CampaignRow,
  CampaignSchema,
  campaignAudience,
  campaignProgress,
  combineTracking,
  EXCLUSION_REASONS,
  loadCampaign,
  toCampaign,
} from "./model";
import { campaignSources, transitionCampaign } from "./state-machine";
import { canonicalTimeZone, localTime } from "./timezone";

// Campaign operations (R31 to R34, R38, R39, R68). Scopes follow the plan's table:
// campaigns:read reads, campaigns:write edits drafts, and campaigns:send prepares,
// confirms, pauses, resumes, cancels, and decides uncertain batches. Sending always
// takes two steps on every surface: prepare returns a token, and confirm spends it.

const idInput = z.object({ id: z.coerce.number().int().positive() });
const SEND_NOW_MCP = {
  class: "now",
  reason: "Prepare and confirm are in the plan's MCP 'now' set. The confirm token binds the key.",
} as const;
const LATER_MCP = (reason: string) => ({ class: "later", reason }) as const;

const EstimateSchema = z
  .object({
    recipients: z.number().int(),
    excluded: z.object(
      Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, z.number().int()])) as Record<
        (typeof EXCLUSION_REASONS)[number],
        z.ZodNumber
      >,
    ),
    isEstimate: z.literal(true).meta({
      description: "Contacts can change before the snapshot, so the count is an estimate.",
    }),
  })
  .meta({ id: "CampaignEstimate" });

const CampaignSummarySchema = CampaignSchema.extend({
  sent: z.number().int().meta({ description: "Recipients sent so far." }),
}).meta({ id: "CampaignSummary" });

const contentInput = {
  name: z.string().trim().min(1).max(200),
  type: z.enum(["regular", "re-permission"]),
  templateId: z.number().int().positive().nullable().meta({
    description:
      "Copies the template's content into the campaign. Later template edits do not change it.",
  }),
  subject: z.string().trim().max(200).nullable(),
  preheader: z.string().trim().max(300).nullable(),
  fromName: z.string().trim().max(100).nullable(),
  fromEmail: z.string().trim().max(320).nullable(),
  replyTo: z.string().trim().max(320).nullable(),
  audience: AudienceSchema,
  trackOpens: z.boolean(),
  trackClicks: z.boolean(),
};

type ContentInput = Partial<{
  [K in keyof typeof contentInput]: z.output<(typeof contentInput)[K]>;
}>;

function cleanEmail(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  const email = normalizeEmail(value);
  if (!email) throw new OperationError("invalid_input", `The ${label} address is not valid.`);
  return email;
}

async function checkAudience(db: DbConnection, workspaceId: number, audience: Audience) {
  await checkLists(db.db, workspaceId, [...audience.listIds, ...audience.excludeListIds]);
  await checkTags(db.db, workspaceId, [...audience.tagIds, ...audience.excludeTagIds]);
}

/** The columns that an edit sets. A template id copies the template's content. */
async function contentColumns(
  ctx: OperationContext,
  input: ContentInput,
): Promise<RowUpdate<"campaigns">> {
  const workspaceId = ctx.principal.workspaceId;
  const set: RowUpdate<"campaigns"> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.type !== undefined) set.type = input.type;
  if (input.preheader !== undefined) set.preheader = input.preheader || null;
  if (input.subject !== undefined) set.subject = input.subject || null;
  if (input.fromName !== undefined) set.from_name = input.fromName || null;
  if (input.fromEmail !== undefined) set.from_email = cleanEmail(input.fromEmail, "From");
  if (input.replyTo !== undefined) set.reply_to = cleanEmail(input.replyTo, "Reply-To");
  if (input.trackOpens !== undefined) set.tracking_opens = input.trackOpens ? 1 : 0;
  if (input.trackClicks !== undefined) set.tracking_clicks = input.trackClicks ? 1 : 0;
  if (input.audience !== undefined) {
    await checkAudience(ctx.db, workspaceId, input.audience);
    set.audience = JSON.stringify(input.audience);
  }
  if (input.templateId !== undefined) {
    set.template_id = input.templateId;
    if (input.templateId === null) {
      set.html = null;
      set.text = null;
    } else {
      const template = await getTemplateRow(ctx.db.db, workspaceId, input.templateId);
      set.html = template.html;
      set.text = template.text;
      // The template's subject and preview text fill the fields that the input leaves empty.
      if (!input.subject && template.subject) set.subject = template.subject;
      if (!input.preheader && template.preheader) set.preheader = template.preheader;
    }
  }
  return set;
}

function requireStatus(campaign: CampaignRow, allowed: readonly string[], action: string) {
  if (!allowed.includes(campaign.status)) {
    throw new OperationError("conflict", `A ${campaign.status} campaign cannot ${action}.`, {
      status: campaign.status,
    });
  }
}

const campaignTarget = (_input: unknown, output: { id: number }) => ({
  targetType: "campaign",
  targetId: output.id,
});

// Read ----------------------------------------------------------------------------------

export const campaignsList = defineOperation({
  id: "campaigns.list",
  summary: "List campaigns",
  description: "Returns the campaigns of the workspace, newest first.",
  method: "get",
  path: "/campaigns",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Agents read campaign drafts and their status." },
  input: z.object({
    ...pageInputShape,
    status: z
      .enum(["draft", "scheduled", "sending", "paused", "needs_decision", "sent", "cancelled"])
      .optional(),
  }),
  output: pageOf(CampaignSummarySchema).meta({ id: "CampaignPage" }),
  async handler(input, { principal, db }) {
    const workspaceId = principal.workspaceId;
    let query = db.db
      .selectFrom("campaigns")
      .selectAll()
      .select((eb) =>
        eb
          .selectFrom("campaign_batches as b")
          .select(sql<number>`COALESCE(SUM(b.sent_count), 0)`.as("sent"))
          .where("b.workspace_id", "=", workspaceId)
          .whereRef("b.campaign_id", "=", "campaigns.id")
          .as("sent"),
      )
      .where("workspace_id", "=", workspaceId);
    if (input.status) query = query.where("status", "=", input.status);
    if (input.cursor !== undefined) query = query.where("id", "<", decodeCursor(input.cursor));
    const rows = await query
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({ ...toCampaign(row), sent: Number(row.sent ?? 0) })),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.id) : null,
    };
  },
});

export const campaignsGet = defineOperation({
  id: "campaigns.get",
  summary: "Get a campaign",
  description:
    "Returns the campaign with its progress: sent, pending, and uncertain recipients. While " +
    "the D1 daily limit stops writes, a sending campaign shows as paused with the reason " +
    "platform_limit and the resume time (KTD24).",
  method: "get",
  path: "/campaigns/{id}",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Agents read campaign status and progress." },
  input: idInput,
  output: CampaignDetailSchema,
  async handler(input, { principal, db, services, now }) {
    const row = await loadCampaign(db, principal.workspaceId, input.id);
    const [progress, connection] = await Promise.all([
      campaignProgress(db, principal.workspaceId, row.id),
      row.connection_id === null
        ? undefined
        : db.db
            .selectFrom("provider_connections")
            .select(["id", "provider", "name"])
            .where("workspace_id", "=", principal.workspaceId)
            .where("id", "=", row.connection_id)
            .executeTakeFirst(),
    ]);
    const campaign = toCampaign(row);
    // The flag lives in the UsageMeter, because D1 takes no write at the limit.
    if (row.status === "sending" && services.usage) {
      const limit = await services.usage
        .status()
        .then((status) => status.platformLimit)
        .catch(() => null);
      if (limit && limit.until > now) {
        Object.assign(campaign, {
          status: "paused",
          pauseReason: "platform_limit",
          pauseDetail: "D1 reached its daily write limit on Workers Free.",
          pausedAt: limit.since,
          resumeAt: limit.until,
        });
      }
    }
    return {
      ...campaign,
      progress,
      provider: connection
        ? { connectionId: connection.id, provider: connection.provider, name: connection.name }
        : null,
    };
  },
});

export const campaignsEstimate = defineOperation({
  id: "campaigns.estimate",
  summary: "Estimate the audience",
  description:
    "Counts the contacts that the campaign would reach now, and the contacts it leaves out " +
    "by reason (AE1). It is an estimate: the snapshot happens at send time.",
  method: "get",
  path: "/campaigns/{id}/estimate",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "The recipient count is part of the draft and checklist." },
  input: idInput,
  output: EstimateSchema,
  async handler(input, { principal, db }) {
    const row = await loadCampaign(db, principal.workspaceId, input.id);
    const estimate = await estimateAudience(
      db,
      principal.workspaceId,
      campaignAudience(row),
      row.type,
    );
    return { ...estimate, isEstimate: true as const };
  },
});

const ChecklistSchema = z
  .object({
    items: z.array(ChecklistItemSchema),
    blocked: z.boolean().meta({ description: "A failed item blocks the send." }),
    estimate: EstimateSchema,
  })
  .meta({ id: "CampaignChecklist" });

export const campaignsChecklist = defineOperation({
  id: "campaigns.checklist",
  summary: "Run the pre-send checklist",
  method: "get",
  path: "/campaigns/{id}/checklist",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "The checklist is in the plan's MCP 'now' set." },
  input: idInput,
  output: ChecklistSchema,
  async handler(input, { principal, db, services }) {
    const campaign = await loadCampaign(db, principal.workspaceId, input.id);
    const estimate = await estimateAudience(
      db,
      principal.workspaceId,
      campaignAudience(campaign),
      campaign.type,
    );
    const checklist = await runChecklist({ db, services, campaign, estimate });
    return {
      items: checklist.items,
      blocked: checklist.blocked,
      estimate: { ...estimate, isEstimate: true as const },
    };
  },
});

export const campaignsPreview = defineOperation({
  id: "campaigns.preview",
  summary: "Preview a campaign",
  description:
    "Personalizes the campaign's content with a contact's values, or with sample values.",
  method: "get",
  path: "/campaigns/{id}/preview",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "The preview is in the plan's MCP 'now' set." },
  contactContent: true,
  input: idInput.extend({ contactId: z.coerce.number().int().positive().optional() }),
  output: z
    .object({
      subject: z.string(),
      preheader: z.string(),
      html: z.string(),
      text: z.string(),
      missing: z.array(z.string()),
    })
    .meta({ id: "CampaignPreview" }),
  async handler(input, { principal, db, services }) {
    const row = await loadCampaign(db, principal.workspaceId, input.id);
    const values = await contactValues(db, principal.workspaceId, input.contactId);
    // A draft shows the live brand. A confirmed campaign shows its brand snapshot.
    const brand = await campaignBrand(db, row, services.appOrigin);
    return personalizePreview(row, values, testLinkOrigin(services.appOrigin), brand);
  },
});

// Drafts -------------------------------------------------------------------------------

export const campaignsCreate = defineOperation({
  id: "campaigns.create",
  summary: "Create a campaign draft",
  method: "post",
  path: "/campaigns",
  scope: "campaigns:write",
  risk: "write",
  mcp: { class: "now", reason: "Campaign drafts are in the plan's MCP 'now' set." },
  successStatus: 201,
  input: z.object({
    ...contentInput,
    type: contentInput.type.default("regular"),
    templateId: contentInput.templateId.optional(),
    subject: contentInput.subject.optional(),
    preheader: contentInput.preheader.optional(),
    fromName: contentInput.fromName.optional(),
    fromEmail: contentInput.fromEmail.optional(),
    replyTo: contentInput.replyTo.optional(),
    audience: AudienceSchema.optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
  }),
  output: CampaignSchema,
  async handler(input, ctx) {
    const set = await contentColumns(ctx, input);
    const row = await ctx.db.db
      .insertInto("campaigns")
      .values({
        workspace_id: ctx.principal.workspaceId,
        parent_id: null,
        name: input.name,
        type: input.type,
        pause_reason: null,
        template_id: null,
        connection_id: null,
        subject: null,
        preheader: null,
        from_name: null,
        from_email: null,
        reply_to: null,
        html: null,
        text: null,
        audience: JSON.stringify(input.audience ?? AudienceSchema.parse({})),
        scheduled_at: null,
        started_at: null,
        completed_at: null,
        snapshot_max_contact_id: null,
        recipient_count: null,
        resume_at: null,
        ...set,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCampaign(row);
  },
  auditTarget: campaignTarget,
});

export const campaignsUpdate = defineOperation({
  id: "campaigns.update",
  summary: "Edit a campaign draft",
  description:
    "Changes a draft. Each edit increments the version, so a confirm token from an earlier " +
    "prepare goes stale (R68). Sending the template id again copies its current content.",
  method: "patch",
  path: "/campaigns/{id}",
  scope: "campaigns:write",
  risk: "write",
  mcp: { class: "now", reason: "Campaign drafts are in the plan's MCP 'now' set." },
  input: idInput.extend(
    Object.fromEntries(
      Object.entries(contentInput).map(([key, schema]) => [key, schema.optional()]),
    ) as { [K in keyof typeof contentInput]: z.ZodOptional<(typeof contentInput)[K]> },
  ),
  output: CampaignSchema,
  async handler(input, ctx) {
    const { id, ...fields } = input;
    const current = await loadCampaign(ctx.db, ctx.principal.workspaceId, id);
    requireStatus(current, ["draft"], "be edited. Unschedule it first");
    const set = await contentColumns(ctx, fields);
    const row = await ctx.db.db
      .updateTable("campaigns")
      .set({ ...set, version: sql`version + 1`, updated_at: ctx.now })
      .where("workspace_id", "=", ctx.principal.workspaceId)
      .where("id", "=", id)
      .where("status", "=", "draft")
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new OperationError("conflict", "The campaign is no longer a draft.");
    return toCampaign(row);
  },
  auditTarget: campaignTarget,
});

export const campaignsDelete = defineOperation({
  id: "campaigns.delete",
  summary: "Delete a campaign draft",
  method: "delete",
  path: "/campaigns/{id}",
  scope: "campaigns:write",
  risk: "destructive",
  mcp: LATER_MCP("Deleting is destructive. The owner deletes drafts in the admin app for now."),
  input: idInput,
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    const result = await db.db
      .deleteFrom("campaigns")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .where("status", "=", "draft")
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) {
      await loadCampaign(db, principal.workspaceId, input.id);
      throw new OperationError(
        "conflict",
        "Only a draft can be deleted. Cancel a sent campaign instead.",
      );
    }
    return { id: input.id };
  },
  auditTarget: campaignTarget,
});

// Prepare and confirm (R68) ---------------------------------------------------------------

const ModeSchema = z.enum(["send_now", "schedule"]);

const PrepareSchema = z
  .object({
    campaignId: z.number().int(),
    campaignVersion: z.number().int(),
    mode: ModeSchema,
    scheduledAt: z.number().int().nullable(),
    timezone: z
      .string()
      .nullable()
      .meta({ description: "The IANA timezone of the schedule. Null for UTC only." }),
    scheduledLocalTime: z.string().nullable().meta({
      description: "The wall-clock time of scheduledAt in timezone, with its UTC offset.",
    }),
    blocked: z.boolean(),
    checklist: z.array(ChecklistItemSchema),
    estimate: EstimateSchema,
    provider: z
      .object({
        connectionId: z.number().int(),
        provider: z.string(),
        providerName: z.string(),
        name: z.string(),
      })
      .nullable(),
    token: z
      .string()
      .nullable()
      .meta({ description: "Pass it to confirm. Null when a check failed." }),
    expiresAt: z.number().int().nullable(),
  })
  .meta({ id: "CampaignPrepare" });

export const campaignsPrepare = defineOperation({
  id: "campaigns.prepare",
  summary: "Prepare a send or a schedule",
  description:
    "Runs the pre-send checklist and estimates the audience. When no check fails, it returns " +
    "a short-lived confirm token, bound to the caller, the campaign version, and the mode. " +
    "Nothing is sent until confirm.",
  method: "post",
  path: "/campaigns/{id}/prepare",
  scope: "campaigns:send",
  risk: "write",
  mcp: SEND_NOW_MCP,
  input: idInput.extend({
    mode: ModeSchema,
    scheduledAt: z.number().int().positive().optional().meta({
      description: "For mode schedule: Unix milliseconds, at least one minute ahead.",
    }),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({
        description:
          "For mode schedule: the IANA timezone that the owner picked the time in, for " +
          "example Asia/Dhaka. It changes only how the time shows, not when the send " +
          "starts. Without it, the schedule has only the UTC time.",
      }),
  }),
  output: PrepareSchema,
  async handler(input, ctx) {
    const { principal, db, services, now } = ctx;
    const campaign = await loadCampaign(db, principal.workspaceId, input.id);
    requireStatus(campaign, ["draft"], "be sent. Only a draft can be prepared");
    let scheduledAt: number | null = null;
    let timezone: string | null = null;
    if (input.mode === "schedule") {
      if (input.scheduledAt === undefined || input.scheduledAt < now + 60_000) {
        throw new OperationError("invalid_input", "Pick a time at least one minute ahead.");
      }
      scheduledAt = input.scheduledAt;
      if (input.timezone !== undefined) {
        timezone = canonicalTimeZone(input.timezone);
        if (timezone === null) {
          throw new OperationError(
            "invalid_input",
            `"${input.timezone}" is not a known IANA timezone. Use a name such as Asia/Dhaka.`,
          );
        }
      }
    }
    const estimate = await estimateAudience(
      db,
      principal.workspaceId,
      campaignAudience(campaign),
      campaign.type,
    );
    const checklist = await runChecklist({ db, services, campaign, estimate });
    let provider: z.input<typeof PrepareSchema>["provider"] = null;
    if (checklist.policy.connectionId !== null) {
      const row = await db.db
        .selectFrom("provider_connections")
        .select(["id", "provider", "name"])
        .where("workspace_id", "=", principal.workspaceId)
        .where("id", "=", checklist.policy.connectionId)
        .executeTakeFirst();
      if (row) {
        provider = {
          connectionId: row.id,
          provider: row.provider,
          providerName: getAdapter(row.provider)?.name ?? row.provider,
          name: row.name,
        };
      }
    }
    const issued = checklist.blocked
      ? null
      : await issueConfirmToken(
          db,
          principal,
          {
            campaignId: campaign.id,
            campaignVersion: campaign.version,
            mode: input.mode,
            scheduledAt,
            timezone,
            estimatedRecipients: estimate.recipients,
          },
          now,
        );
    return {
      campaignId: campaign.id,
      campaignVersion: campaign.version,
      mode: input.mode,
      scheduledAt,
      timezone,
      scheduledLocalTime:
        scheduledAt !== null && timezone !== null ? localTime(scheduledAt, timezone) : null,
      blocked: checklist.blocked,
      checklist: checklist.items,
      estimate: { ...estimate, isEstimate: true as const },
      provider,
      token: issued?.token ?? null,
      expiresAt: issued?.expiresAt ?? null,
    };
  },
  auditTarget: (input, output) => ({
    targetType: "campaign",
    targetId: input.id,
    metadata: { mode: input.mode, blocked: output.blocked, version: output.campaignVersion },
  }),
});

/** The https origin of the campaign's unsubscribe and tracking links. */
async function linkOrigin(ctx: OperationContext, campaign: CampaignRow): Promise<string> {
  const domain = campaign.from_email?.split("@")[1];
  const row = domain
    ? await ctx.db.db
        .selectFrom("sending_domains")
        .select(["tracking_domain", "tracking_status"])
        .where("workspace_id", "=", ctx.principal.workspaceId)
        .where("domain", "=", domain)
        .executeTakeFirst()
    : undefined;
  return testLinkOrigin(ctx.services.appOrigin, verifiedTrackingDomain(row));
}

export const campaignsConfirm = defineOperation({
  id: "campaigns.confirm",
  summary: "Confirm a send or a schedule",
  description:
    "Spends the token from prepare. Send now starts the snapshot and the send at once. " +
    "Schedule sets the time, and the cron starts the send then. The token fails after an " +
    "edit (stale), after its time (expired), on a second use, and for another caller.",
  method: "post",
  path: "/campaigns/{id}/confirm",
  scope: "campaigns:send",
  risk: "external_send",
  mcp: SEND_NOW_MCP,
  input: idInput.extend({ token: z.string().min(1).max(200) }),
  output: CampaignSchema,
  async handler(input, ctx) {
    const { principal, db, now, services } = ctx;
    const campaign = await loadCampaign(db, principal.workspaceId, input.id);
    // After a restore, sends wait until the owner confirms the age of the backup (KTD3).
    await assertNoRestoreHold(db);
    const token = await consumeConfirmToken(db, principal, campaign, input.token, now);
    // The policy can change between prepare and confirm, for example a removed connection.
    const policy = await assertCampaignPolicy(db, principal.workspaceId);
    const origin = await linkOrigin(ctx, campaign);
    // Fix the tracking of the send, so a later change of the workspace switches does
    // not change what the stats and the follow-up report for it.
    const workspace = await db.db
      .selectFrom("workspaces")
      .select(["tracking_opens", "tracking_clicks"])
      .where("id", "=", principal.workspaceId)
      .executeTakeFirstOrThrow();
    // Freeze the brand (KTD10): the batches fill the brand tokens from this snapshot, so
    // a later change of the brand kit does not reach this campaign (R19, AE5). The logo
    // URL uses the link origin, which recipients can reach.
    const brand = await liveBrand(db, principal.workspaceId, origin);
    if (!brand.address.trim()) {
      throw new OperationError(
        "conflict",
        "Add the postal address to the brand kit, then prepare the send again.",
        { fix: "/brand" },
      );
    }
    const sendNow = token.mode === "send_now";
    const set: RowUpdate<"campaigns"> = {
      connection_id: policy.connectionId,
      link_origin: origin,
      brand_snapshot: JSON.stringify(brand),
      ...combineTracking(campaign, workspace),
      scheduled_at: sendNow ? null : token.scheduled_at,
      scheduled_tz: sendNow ? null : token.scheduled_tz,
      scheduled_local:
        sendNow || token.scheduled_at === null || token.scheduled_tz === null
          ? null
          : localTime(token.scheduled_at, token.scheduled_tz),
      ...(sendNow ? { started_at: now } : {}),
      status: sendNow ? "sending" : "scheduled",
      updated_at: now,
    };
    const row = await db.db
      .updateTable("campaigns")
      .set(set)
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", campaign.id)
      .where("status", "=", "draft")
      .where("version", "=", token.campaign_version)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw confirmError("stale", "The campaign changed after you prepared the send.");
    if (sendNow) {
      await requireService(
        services,
        "startCampaignJob",
      )({
        workspaceId: principal.workspaceId,
        campaignId: row.id,
        startedAt: now,
      });
    }
    return toCampaign(row);
  },
  auditTarget: (_input, output) => ({
    targetType: "campaign",
    targetId: output.id,
    metadata: {
      status: output.status,
      version: output.version,
      scheduledAt: output.scheduledAt,
      scheduledTimezone: output.scheduledTimezone,
    },
  }),
});

// Pause, resume, cancel ---------------------------------------------------------------------

function lifecycleOperation(options: {
  id: string;
  verb: string;
  summary: string;
  description: string;
  risk: "write" | "destructive" | "external_send";
  mcp: { class: "now" | "later"; reason: string };
  run(ctx: OperationContext, campaign: CampaignRow): Promise<void>;
}) {
  return defineOperation({
    id: options.id,
    summary: options.summary,
    description: options.description,
    method: "post",
    path: `/campaigns/{id}/${options.verb}`,
    scope: "campaigns:send",
    risk: options.risk,
    mcp: options.mcp,
    input: idInput,
    output: CampaignSchema,
    async handler(input, ctx) {
      const campaign = await loadCampaign(ctx.db, ctx.principal.workspaceId, input.id);
      await options.run(ctx, campaign);
      return toCampaign(await loadCampaign(ctx.db, ctx.principal.workspaceId, input.id));
    },
    auditTarget: campaignTarget,
  });
}

async function changeOrConflict(
  ctx: OperationContext,
  campaign: CampaignRow,
  trigger: Parameters<typeof campaignSources>[0],
  to: CampaignRow["status"],
  set: RowUpdate<"campaigns">,
  action: string,
) {
  const from = campaignSources(trigger);
  requireStatus(campaign, from, action);
  const changed = await transitionCampaign(
    ctx.db,
    ctx.principal.workspaceId,
    campaign.id,
    from,
    to,
    ctx.now,
    set,
  );
  if (!changed)
    throw new OperationError("conflict", `The campaign changed. It cannot ${action} now.`);
}

export const campaignsUnschedule = lifecycleOperation({
  id: "campaigns.unschedule",
  verb: "unschedule",
  summary: "Unschedule a campaign",
  description:
    "Moves a scheduled campaign back to draft. A new send needs a new prepare and confirm.",
  risk: "write",
  mcp: { class: "now", reason: "Unschedule stops a send. It never sends." },
  run: (ctx, campaign) =>
    changeOrConflict(
      ctx,
      campaign,
      "unschedule",
      "draft",
      // A new confirm takes a new brand snapshot. Until then, the draft shows the live brand.
      { scheduled_at: null, scheduled_tz: null, scheduled_local: null, brand_snapshot: null },
      "be unscheduled",
    ),
});

export const campaignsPause = lifecycleOperation({
  id: "campaigns.pause",
  verb: "pause",
  summary: "Pause a campaign",
  description: "Stops sending. Batches in flight finish. Queued batches wait until resume (R34).",
  risk: "write",
  mcp: { class: "now", reason: "Pause and resume are in the plan's MCP 'now' set." },
  run: (ctx, campaign) =>
    changeOrConflict(
      ctx,
      campaign,
      "pause",
      "paused",
      { pause_reason: "manual", pause_detail: null, paused_at: ctx.now, resume_at: null },
      "be paused",
    ),
});

export const campaignsResume = lifecycleOperation({
  id: "campaigns.resume",
  verb: "resume",
  summary: "Resume a campaign",
  description:
    "Sends the rest of a paused campaign. A platform_limit pause resumes on its own after " +
    "00:00 UTC, and cannot resume before.",
  risk: "external_send",
  mcp: { class: "now", reason: "Pause and resume are in the plan's MCP 'now' set." },
  async run(ctx, campaign) {
    const limit = await ctx.services.usage
      ?.status()
      .then((status) => status.platformLimit)
      .catch(() => null);
    if (
      (limit && limit.until > ctx.now) ||
      (campaign.pause_reason === "platform_limit" && (campaign.resume_at ?? 0) > ctx.now)
    ) {
      throw new OperationError(
        "conflict",
        "D1 reached its daily write limit. The campaign resumes on its own after 00:00 UTC.",
        { reason: "platform_limit", resumeAt: limit?.until ?? campaign.resume_at },
      );
    }
    await changeOrConflict(
      ctx,
      campaign,
      "resume",
      "sending",
      { pause_reason: null, pause_detail: null, resume_at: null },
      "resume",
    );
    // The consumer dropped the queued messages while paused, so they all go again.
    await dispatchAll(
      ctx.db,
      requireService(ctx.services, "sendQueue"),
      ctx.principal.workspaceId,
      campaign.id,
      ctx.now,
      {
        enqueuedBefore: ctx.now,
      },
    );
  },
});

export const campaignsCancel = lifecycleOperation({
  id: "campaigns.cancel",
  verb: "cancel",
  summary: "Cancel a campaign",
  description: "Stops the campaign for good. Recipients who got it keep it.",
  risk: "destructive",
  mcp: LATER_MCP("Cancel cannot be undone. The plan keeps it for the admin app in v1."),
  run: (ctx, campaign) =>
    changeOrConflict(
      ctx,
      campaign,
      "cancel",
      "cancelled",
      { completed_at: ctx.now },
      "be cancelled",
    ),
});

// Uncertain batches (R38) -----------------------------------------------------------------

const BatchSchema = z
  .object({
    id: z.number().int(),
    seq: z.number().int(),
    status: z.enum(BATCH_STATUSES),
    recipientCount: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    open: z.number().int().meta({
      description:
        "Recipients without a known result. For an uncertain batch: they may have received it.",
    }),
    attempts: z.number().int(),
    uncertainAt: z.number().int().nullable(),
    lastError: z.string().nullable(),
  })
  .meta({ id: "CampaignBatch" });

export const campaignsBatches = defineOperation({
  id: "campaigns.batches",
  summary: "List a campaign's batches",
  description: "Lists batches, for example the uncertain ones that wait for a decision.",
  method: "get",
  path: "/campaigns/{id}/batches",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "Agents read why a campaign waits for a decision." },
  input: idInput.extend({ status: z.enum(BATCH_STATUSES).optional() }),
  output: z.object({ items: z.array(BatchSchema) }).meta({ id: "CampaignBatchList" }),
  async handler(input, { principal, db }) {
    await loadCampaign(db, principal.workspaceId, input.id);
    let query = db.db
      .selectFrom("campaign_batches")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .where("campaign_id", "=", input.id);
    if (input.status) query = query.where("status", "=", input.status);
    const rows = await query.orderBy("seq", "asc").limit(200).execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        status: row.status,
        recipientCount: row.recipient_count,
        sent: row.sent_count,
        failed: row.failed_count,
        skipped: row.skipped_count,
        open: Math.max(
          0,
          row.recipient_count - row.sent_count - row.failed_count - row.skipped_count,
        ),
        attempts: row.attempts,
        uncertainAt: row.uncertain_at,
        lastError: row.last_error,
      })),
    };
  },
});

const batchInput = idInput.extend({ batchId: z.coerce.number().int().positive() });

const DecisionSchema = z
  .object({ campaign: CampaignSchema, batch: BatchSchema.pick({ id: true, status: true }) })
  .meta({ id: "CampaignBatchDecision" });

async function loadUncertain(ctx: OperationContext, campaignId: number, batchId: number) {
  const campaign = await loadCampaign(ctx.db, ctx.principal.workspaceId, campaignId);
  const batch = await ctx.db.db
    .selectFrom("campaign_batches")
    .selectAll()
    .where("workspace_id", "=", ctx.principal.workspaceId)
    .where("campaign_id", "=", campaignId)
    .where("id", "=", batchId)
    .executeTakeFirst();
  if (!batch) throw new OperationError("not_found", "The batch does not exist.");
  if (batch.status !== "uncertain") {
    throw new OperationError("conflict", `The batch is ${batch.status}, not uncertain.`);
  }
  if (campaign.status === "cancelled")
    throw new OperationError("conflict", "The campaign is cancelled.");
  return { campaign, batch };
}

export const campaignsRetryBatch = defineOperation({
  id: "campaigns.retry_batch",
  summary: "Retry an uncertain batch",
  description:
    "Sends the batch's open recipients again. The provider may have sent them already, so " +
    "they can get the email twice. The input must accept that risk.",
  method: "post",
  path: "/campaigns/{id}/batches/{batchId}/retry",
  scope: "campaigns:send",
  risk: "external_send",
  mcp: LATER_MCP("A retry can send duplicates. The plan keeps the decision in the admin app."),
  input: batchInput.extend({
    acceptDuplicateRisk: z
      .literal(true)
      .meta({ description: "Confirms that recipients may get the email twice." }),
  }),
  output: DecisionSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const { campaign } = await loadUncertain(ctx, input.id, input.batchId);
    // A fresh claim, with a fresh send-time check and a new key.
    const result = await db.db
      .updateTable("campaign_batches")
      .set({
        status: "pending",
        recipient_set: null,
        idempotency_key: null,
        uncertain_at: null,
        not_before: null,
        last_error: null,
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.batchId)
      .where("status", "=", "uncertain")
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0)
      throw new OperationError("conflict", "The batch changed.");
    if (campaign.status === "needs_decision") {
      await transitionCampaign(
        db,
        principal.workspaceId,
        campaign.id,
        ["needs_decision"],
        "sending",
        now,
        {
          completed_at: null,
        },
      );
    }
    await dispatchBatches(
      db,
      requireService(ctx.services, "sendQueue"),
      principal.workspaceId,
      campaign.id,
      now,
    );
    return {
      campaign: toCampaign(await loadCampaign(db, principal.workspaceId, campaign.id)),
      batch: { id: input.batchId, status: "pending" as const },
    };
  },
  auditTarget: (input) => ({
    targetType: "campaign_batch",
    targetId: input.batchId,
    metadata: { campaignId: input.id, acceptDuplicateRisk: true },
  }),
});

export const campaignsSkipBatch = defineOperation({
  id: "campaigns.skip_batch",
  summary: "Skip an uncertain batch",
  description: "Gives up on the batch's open recipients. Nothing is sent to them again.",
  method: "post",
  path: "/campaigns/{id}/batches/{batchId}/skip",
  scope: "campaigns:send",
  risk: "write",
  mcp: LATER_MCP("The decision on uncertain batches stays in the admin app in v1."),
  input: batchInput,
  output: DecisionSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const { campaign } = await loadUncertain(ctx, input.id, input.batchId);
    const workspaceId = principal.workspaceId;
    const out = await db.atomic([
      sql`UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'uncertain_skipped'
WHERE workspace_id = ${workspaceId} AND batch_id = ${input.batchId} AND status = 'pending'
  AND EXISTS (SELECT 1 FROM campaign_batches b WHERE b.workspace_id = ${workspaceId} AND b.id = ${input.batchId} AND b.status = 'uncertain')`.compile(
        db.db,
      ),
      sql`UPDATE campaign_batches SET status = 'skipped', recipient_set = NULL,
  skipped_count = recipient_count - sent_count - failed_count, updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND id = ${input.batchId} AND status = 'uncertain'`.compile(
        db.db,
      ),
    ]);
    if ((out[1]?.meta.changes ?? 0) === 0)
      throw new OperationError("conflict", "The batch changed.");
    await tryFinalizeCampaign(db, workspaceId, campaign.id, now);
    return {
      campaign: toCampaign(await loadCampaign(db, workspaceId, campaign.id)),
      batch: { id: input.batchId, status: "skipped" as const },
    };
  },
  auditTarget: (input) => ({
    targetType: "campaign_batch",
    targetId: input.batchId,
    metadata: { campaignId: input.id },
  }),
});
