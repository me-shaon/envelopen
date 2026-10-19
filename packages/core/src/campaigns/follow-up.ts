import type { DbConnection } from "@envelopen/db";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation } from "../registry/operation";
import {
  type CampaignRow,
  CampaignSchema,
  loadCampaign,
  type SendTracking,
  sendTracking,
  toCampaign,
} from "./model";

// Follow-up to non-openers (R35). A follow-up is a child campaign: a draft that copies
// the parent's content, audience, and tracking switches, with `parent_id` set. Its
// audience keeps to the contacts that got the parent and have no human open of it
// (audience.ts). Machine-only openers stay in, because a machine open says nothing
// about the person (KTD29). The draft then goes through the normal prepare and confirm
// (R68), so the owner can edit the subject first.
//
// A follow-up needs open tracking on the parent's send, as stored at confirm. Without it
// every recipient looks like a non-opener, so the follow-up is unavailable.

/** A parent can have a follow-up once its send has stopped. */
const FINISHED: readonly CampaignRow["status"][] = ["sent", "needs_decision", "cancelled"];

export interface FollowUpAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * Whether the campaign can have a follow-up. `tracking` is the tracking that applied to
 * the send, when the caller has read it already (stats). Otherwise it is read here.
 */
export async function followUpAvailability(
  db: DbConnection,
  campaign: CampaignRow,
  tracking?: SendTracking,
): Promise<FollowUpAvailability> {
  if (campaign.started_at === null || !FINISHED.includes(campaign.status)) {
    return {
      available: false,
      reason: "A follow-up is possible after the campaign has finished sending.",
    };
  }
  const opens = (tracking ?? (await sendTracking(db, campaign))).opens;
  if (!opens) {
    return {
      available: false,
      reason:
        "Open tracking was off for this campaign, so Envelopen cannot tell who did not open it.",
    };
  }
  return { available: true, reason: null };
}

export const campaignsFollowUp = defineOperation({
  id: "campaigns.follow_up",
  summary: "Create a follow-up to non-openers",
  description:
    "Creates a draft that copies the campaign's content and audience and reaches only the " +
    "recipients who did not open it as a person. Machine-only openers, for example Apple " +
    "Mail Privacy Protection, are included. Send it with prepare and confirm. It fails when " +
    "the campaign was sent with open tracking off.",
  method: "post",
  path: "/campaigns/{id}/follow-up",
  scope: "campaigns:write",
  risk: "write",
  mcp: {
    class: "now",
    reason:
      "Follow-up is in the plan's MCP 'now' set. It creates a draft. Sending it takes " +
      "prepare and confirm.",
  },
  successStatus: 201,
  input: z.object({
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional().meta({
      description: 'Defaults to the parent\'s name with " (follow-up)".',
    }),
  }),
  output: CampaignSchema,
  async handler(input, { principal, db }) {
    const workspaceId = principal.workspaceId;
    const parent = await loadCampaign(db, workspaceId, input.id);
    const availability = await followUpAvailability(db, parent);
    if (!availability.available) {
      throw new OperationError("conflict", availability.reason ?? "No follow-up is possible.");
    }
    const row = await db.db
      .insertInto("campaigns")
      .values({
        workspace_id: workspaceId,
        parent_id: parent.id,
        type: parent.type,
        name: input.name ?? `${parent.name} (follow-up)`.slice(0, 200),
        pause_reason: null,
        template_id: parent.template_id,
        connection_id: null,
        subject: parent.subject,
        preheader: parent.preheader,
        from_name: parent.from_name,
        from_email: parent.from_email,
        reply_to: parent.reply_to,
        html: parent.html,
        text: parent.text,
        audience: parent.audience,
        tracking_opens: parent.tracking_opens,
        tracking_clicks: parent.tracking_clicks,
        scheduled_at: null,
        started_at: null,
        completed_at: null,
        snapshot_max_contact_id: null,
        recipient_count: null,
        resume_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCampaign(row);
  },
  auditTarget: (input, output) => ({
    targetType: "campaign",
    targetId: output.id,
    metadata: { parentId: input.id },
  }),
});
