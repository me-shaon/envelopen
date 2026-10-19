import type { ConsentBasis, Database } from "@envelopen/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Principal } from "../principal";

// The contact read model (R14, R64). A contact's status is derived, in this order:
// - `suppressed`: a suppression row has the contact's address hash (R19).
// - `unsubscribed`: the contact unsubscribed from every list (F3). The row stays visible.
// - `subscribed`: otherwise. List memberships carry their own status, source, and time.

export const CONSENT_BASES = ["existing_customer", "explicit_opt_in", "unknown"] as const;
export const CONTACT_STATUSES = ["subscribed", "unsubscribed", "suppressed"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const ConsentBasisSchema = z.enum(CONSENT_BASES).meta({
  id: "ConsentBasis",
  description:
    "Why the workspace may email the contact. `unknown` contacts get re-permission campaigns only.",
});

export const ListMembershipSchema = z
  .object({
    listId: z.number().int(),
    listName: z.string(),
    status: z.enum(["subscribed", "unsubscribed"]),
    source: z.string().meta({ description: "Source of the last status change." }),
    at: z.number().int().meta({ description: "Unix milliseconds of the last status change." }),
    campaignId: z.number().int().nullable(),
  })
  .meta({ id: "ListMembership" });

export const TagRefSchema = z.object({ id: z.number().int(), name: z.string() }).meta({
  id: "TagRef",
});

export const ContactSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    status: z.enum(CONTACT_STATUSES),
    consentBasis: ConsentBasisSchema,
    consentSource: z.string(),
    consentAt: z.number().int().meta({ description: "Unix milliseconds." }),
    source: z.string().meta({ description: "For example `ui`, `import:12`, or `api_key:3`." }),
    unsubscribedAt: z.number().int().nullable(),
    unsubscribeSource: z.string().nullable(),
    unsubscribeCampaignId: z.number().int().nullable(),
    suppressionReason: z.string().nullable(),
    suppressedAt: z.number().int().nullable(),
    tags: z.array(TagRefSchema),
    lists: z.array(ListMembershipSchema),
    fields: z.record(z.string(), z.string().nullable()).meta({
      description: "Custom field values by field key.",
    }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "Contact" });

export type Contact = z.input<typeof ContactSchema>;

/** The source that a principal writes on contacts and memberships. */
export function actorSource(principal: Principal): string {
  return principal.actorType === "api_key" ? `api_key:${principal.actorId}` : "ui";
}

export function contactStatus(row: {
  suppression_reason: string | null;
  unsubscribed_at: number | null;
}): ContactStatus {
  if (row.suppression_reason !== null) return "suppressed";
  if (row.unsubscribed_at !== null) return "unsubscribed";
  return "subscribed";
}

/** Contacts with a suppression joined on the address hash. Add filters and a select. */
export function contactBase(db: Kysely<Database>, workspaceId: number) {
  return db
    .selectFrom("contacts as c")
    .leftJoin("suppressions as s", (join) =>
      join.onRef("s.email_hash", "=", "c.email_hash").on("s.workspace_id", "=", workspaceId),
    )
    .where("c.workspace_id", "=", workspaceId);
}

const BASE_COLUMNS = [
  "c.id",
  "c.email",
  "c.first_name",
  "c.last_name",
  "c.consent_basis",
  "c.consent_source",
  "c.consent_at",
  "c.source",
  "c.unsubscribed_at",
  "c.unsubscribe_source",
  "c.unsubscribe_campaign_id",
  "c.created_at",
  "c.updated_at",
  "s.reason as suppression_reason",
  "s.created_at as suppressed_at",
] as const;

/**
 * Loads contacts with their tags, list memberships, and custom fields, in the order of
 * `ids`. Missing ids are left out. Four queries, whatever the page size.
 */
export async function loadContacts(
  db: Kysely<Database>,
  workspaceId: number,
  ids: readonly number[],
): Promise<Contact[]> {
  if (ids.length === 0) return [];
  const idList = [...ids];
  const [rows, tags, lists, fields] = await Promise.all([
    contactBase(db, workspaceId).select(BASE_COLUMNS).where("c.id", "in", idList).execute(),
    db
      .selectFrom("contact_tags as ct")
      .innerJoin("tags as t", "t.id", "ct.tag_id")
      .select(["ct.contact_id", "t.id", "t.name"])
      .where("ct.workspace_id", "=", workspaceId)
      .where("ct.contact_id", "in", idList)
      .orderBy("t.name")
      .execute(),
    db
      .selectFrom("list_members as m")
      .innerJoin("lists as l", "l.id", "m.list_id")
      .select([
        "m.contact_id",
        "l.id",
        "l.name",
        "m.status",
        "m.status_source",
        "m.status_at",
        "m.status_campaign_id",
      ])
      .where("m.workspace_id", "=", workspaceId)
      .where("m.contact_id", "in", idList)
      .orderBy("l.name")
      .execute(),
    db
      .selectFrom("contact_field_values as v")
      .innerJoin("contact_fields as f", "f.id", "v.field_id")
      .select(["v.contact_id", "f.key", "v.value"])
      .where("v.workspace_id", "=", workspaceId)
      .where("v.contact_id", "in", idList)
      .execute(),
  ]);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const group = <T extends { contact_id: number }>(items: T[]) => {
    const map = new Map<number, T[]>();
    for (const item of items) {
      const list = map.get(item.contact_id) ?? [];
      list.push(item);
      map.set(item.contact_id, list);
    }
    return map;
  };
  const tagsOf = group(tags);
  const listsOf = group(lists);
  const fieldsOf = group(fields);

  const contacts: Contact[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    contacts.push({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      status: contactStatus(row),
      consentBasis: row.consent_basis as ConsentBasis,
      consentSource: row.consent_source,
      consentAt: row.consent_at,
      source: row.source,
      unsubscribedAt: row.unsubscribed_at,
      unsubscribeSource: row.unsubscribe_source,
      unsubscribeCampaignId: row.unsubscribe_campaign_id,
      suppressionReason: row.suppression_reason,
      suppressedAt: row.suppressed_at,
      tags: (tagsOf.get(id) ?? []).map((tag) => ({ id: tag.id, name: tag.name })),
      lists: (listsOf.get(id) ?? []).map((list) => ({
        listId: list.id,
        listName: list.name,
        status: list.status,
        source: list.status_source,
        at: list.status_at,
        campaignId: list.status_campaign_id,
      })),
      fields: Object.fromEntries((fieldsOf.get(id) ?? []).map((field) => [field.key, field.value])),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return contacts;
}
