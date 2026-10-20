import type { Database } from "@envelopen/db";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { z } from "zod";
import { CONTACT_STATUSES, type ContactStatus, contactBase } from "./model";

// Contact filters, shared by the contact list and the export.
//
// The status filter reads the contact status. With a list filter, `subscribed` and
// `unsubscribed` read the membership in that list instead, so the owner can find the
// contacts who left one list (R64).

export const contactFilterShape = {
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .meta({ description: "Matches part of the email address or the name." }),
  listId: z.coerce.number().int().positive().optional(),
  tagId: z.coerce.number().int().positive().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
};

export interface ContactFilters {
  search?: string | undefined;
  listId?: number | undefined;
  tagId?: number | undefined;
  status?: ContactStatus | undefined;
}

/** True when a filter narrows the contacts. An empty or blank search narrows nothing. */
export function hasContactFilters(filters: ContactFilters): boolean {
  return (
    Boolean(filters.search?.trim()) ||
    filters.listId !== undefined ||
    filters.tagId !== undefined ||
    filters.status !== undefined
  );
}

type ContactQueryDb = Database & { c: Database["contacts"]; s: Database["suppressions"] };

function likePattern(text: string): string {
  return `%${text.toLowerCase().replaceAll(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** Contacts of the workspace that match the filters. Add a select, order, and limit. */
export function filteredContacts(
  db: Kysely<Database>,
  workspaceId: number,
  filters: ContactFilters,
) {
  let query = contactBase(db, workspaceId);
  const search = filters.search?.trim();
  if (search) {
    const pattern = likePattern(search);
    query = query.where(
      sql<boolean>`lower(c.email || ' ' || coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) LIKE ${pattern} ESCAPE '\\'`,
    );
  }
  if (filters.tagId !== undefined) {
    const tagId = filters.tagId;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("contact_tags as ct")
          .select("ct.contact_id")
          .where("ct.workspace_id", "=", workspaceId)
          .where("ct.tag_id", "=", tagId)
          .whereRef("ct.contact_id", "=", "c.id"),
      ),
    );
  }
  const listId = filters.listId;
  const membership = (eb: ExpressionBuilder<ContactQueryDb, "c" | "s">, status?: string) => {
    let sub = eb
      .selectFrom("list_members as m")
      .select("m.contact_id")
      .where("m.workspace_id", "=", workspaceId)
      .where("m.list_id", "=", listId as number)
      .whereRef("m.contact_id", "=", "c.id");
    if (status) sub = sub.where("m.status", "=", status as "subscribed" | "unsubscribed");
    return eb.exists(sub);
  };
  if (listId !== undefined && filters.status !== "subscribed") {
    query = query.where((eb) => membership(eb));
  }
  switch (filters.status) {
    case "suppressed":
      query = query.where("s.id", "is not", null);
      break;
    case "subscribed":
      query = query.where("s.id", "is", null).where("c.unsubscribed_at", "is", null);
      if (listId !== undefined) query = query.where((eb) => membership(eb, "subscribed"));
      break;
    case "unsubscribed":
      query = query.where("s.id", "is", null);
      query =
        listId === undefined
          ? query.where("c.unsubscribed_at", "is not", null)
          : query.where((eb) =>
              eb.and([
                membership(eb),
                eb.or([eb("c.unsubscribed_at", "is not", null), membership(eb, "unsubscribed")]),
              ]),
            );
      break;
    default:
      break;
  }
  return query;
}
