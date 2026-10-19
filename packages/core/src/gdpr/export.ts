import type { Database } from "@envelopen/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ConsentEventSchema } from "../consent/operations";
import { type Contact, ContactSchema } from "../contacts/model";
import type { EmailHasher } from "../services";

// The data export of one contact (R21): everything Envelopen holds about the person,
// as one JSON document. The owner hands it over on a subject access request.

/** The export lists at most this many rows of each activity kind. */
export const MAX_EXPORT_ROWS = 5000;

const CampaignActivitySchema = z.object({
  campaignId: z.number().int(),
  campaignName: z.string(),
  subject: z.string().nullable(),
  status: z.enum(["pending", "sent", "failed", "skipped"]),
  skipReason: z.string().nullable(),
  sentAt: z.number().int().nullable(),
  openedAt: z.number().int().nullable(),
  clickedAt: z.number().int().nullable(),
});

const EventSchema = z.object({
  type: z.string(),
  campaignId: z.number().int().nullable(),
  url: z.string().nullable().meta({ description: "The link of a click." }),
  machine: z.boolean().meta({ description: "An open that a mail privacy proxy made." }),
  bot: z.boolean().meta({ description: "A click that a link scanner made." }),
  occurredAt: z.number().int(),
});

const ProviderEventSchema = z.object({
  provider: z.string(),
  type: z.string(),
  detail: z.string().nullable(),
  occurredAt: z.number().int(),
});

export const ContactExportSchema = z
  .object({
    exportedAt: z.number().int().meta({ description: "Unix milliseconds." }),
    contact: ContactSchema.meta({
      description: "The contact with tags, list memberships, custom fields, and status.",
    }),
    suppression: z
      .object({
        suppressed: z.boolean(),
        reason: z.string().nullable(),
        since: z.number().int().nullable(),
      })
      .meta({ description: "Whether Envelopen blocks all email to the address." }),
    consentEvents: z.array(ConsentEventSchema).meta({ description: "Oldest first." }),
    campaigns: z
      .array(CampaignActivitySchema)
      .meta({ description: "Campaigns that included the contact, oldest first." }),
    events: z
      .array(EventSchema)
      .meta({ description: "Opens, clicks, bounces, and other email events, oldest first." }),
    providerEvents: z
      .array(ProviderEventSchema)
      .meta({ description: "Raw delivery events from the email provider, oldest first." }),
    truncated: z.boolean().meta({
      description: `True when a list reached ${MAX_EXPORT_ROWS} rows and older rows are left out.`,
    }),
  })
  .meta({ id: "ContactExport" });

export type ContactExport = z.input<typeof ContactExportSchema>;

/** Builds the export of a loaded contact. Five reads, whatever the history size. */
export async function buildContactExport(
  db: Kysely<Database>,
  workspaceId: number,
  contact: Contact,
  hashEmail: EmailHasher,
  now: number,
): Promise<ContactExport> {
  const emailHash = await hashEmail(contact.email);
  const take = MAX_EXPORT_ROWS + 1;
  const [consent, recipients, events, providerEvents] = await Promise.all([
    db
      .selectFrom("consent_events")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", contact.id)
      .orderBy("id")
      .limit(take)
      .execute(),
    db
      .selectFrom("campaign_recipients as r")
      .innerJoin("campaigns as c", "c.id", "r.campaign_id")
      .select([
        "r.campaign_id",
        "c.name",
        "c.subject",
        "r.status",
        "r.skip_reason",
        "r.sent_at",
        "r.opened_at",
        "r.clicked_at",
      ])
      .where("r.workspace_id", "=", workspaceId)
      .where("c.workspace_id", "=", workspaceId)
      .where("r.contact_id", "=", contact.id)
      .orderBy("r.id")
      .limit(take)
      .execute(),
    db
      .selectFrom("email_events as e")
      .leftJoin("links as l", "l.id", "e.link_id")
      .select(["e.type", "e.campaign_id", "l.url", "e.is_machine", "e.is_bot", "e.occurred_at"])
      .where("e.workspace_id", "=", workspaceId)
      .where("e.contact_id", "=", contact.id)
      .orderBy("e.id")
      .limit(take)
      .execute(),
    db
      .selectFrom("provider_events")
      .select(["provider", "type", "detail", "occurred_at"])
      .where("workspace_id", "=", workspaceId)
      .where("email_hash", "=", emailHash)
      .orderBy("id")
      .limit(take)
      .execute(),
  ]);
  const truncated = [consent, recipients, events, providerEvents].some(
    (rows) => rows.length > MAX_EXPORT_ROWS,
  );
  const cap = <T>(rows: T[]) => rows.slice(0, MAX_EXPORT_ROWS);

  return {
    exportedAt: now,
    contact,
    suppression: {
      suppressed: contact.status === "suppressed",
      reason: contact.suppressionReason,
      since: contact.suppressedAt,
    },
    consentEvents: cap(consent).map((row) => ({
      id: row.id,
      basis: row.basis,
      source: row.source,
      actorType: row.actor_type,
      actorId: row.actor_id,
      note: row.note,
      createdAt: row.created_at,
    })),
    campaigns: cap(recipients).map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.name,
      subject: row.subject,
      status: row.status,
      skipReason: row.skip_reason,
      sentAt: row.sent_at,
      openedAt: row.opened_at,
      clickedAt: row.clicked_at,
    })),
    events: cap(events).map((row) => ({
      type: row.type,
      campaignId: row.campaign_id,
      url: row.url,
      machine: row.is_machine === 1,
      bot: row.is_bot === 1,
      occurredAt: row.occurred_at,
    })),
    providerEvents: cap(providerEvents).map((row) => ({
      provider: row.provider,
      type: row.type,
      detail: row.detail,
      occurredAt: row.occurred_at,
    })),
    truncated,
  };
}
