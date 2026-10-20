import { z } from "zod";
import { OperationError } from "../errors";
import { encodeCursor, pageInputShape, pageOf, pageParams } from "../pagination";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { normalizeEmail } from "./email";
import { actorSource, ConsentBasisSchema, ContactSchema, loadContacts } from "./model";
import { contactFilterShape, filteredContacts, hasContactFilters } from "./query";
import { upsertContact } from "./upsert";
import { checkTags, ensureFields, ensureTags, setFieldValues, tagContacts } from "./writes";

// Contacts (R14, R57, R64, R73). Reads, upsert, tags, and membership are "now" for
// MCP (plan: MCP classification). Delete is "later" with erase.

const ContactId = z.coerce.number().int().positive();
const Name = z.string().trim().max(100);
const FieldsInput = z
  .record(z.string(), z.string().max(1000).nullable())
  .refine((fields) => Object.keys(fields).length <= 20, "At most 20 fields.")
  .meta({
    description:
      "Custom field values by key (lowercase letters, digits, underscores). Missing fields are created. Null clears a value.",
  });
const TagNames = z.array(z.string()).max(20);

async function requireContact(ctx: OperationContext, id: number) {
  const [contact] = await loadContacts(ctx.db.db, ctx.principal.workspaceId, [id]);
  if (!contact) throw new OperationError("not_found", "The contact does not exist.");
  return contact;
}

export const contactsList = defineOperation({
  id: "contacts.list",
  summary: "List contacts",
  description:
    "Returns contacts, newest first, with tags, list memberships, and status. Filter by " +
    "search text, list, tag, or status. With `listId`, the status `subscribed` or " +
    "`unsubscribed` reads the membership in that list.",
  method: "get",
  path: "/contacts",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "Contact search is in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({ ...contactFilterShape, ...pageInputShape }),
  output: pageOf(ContactSchema),
  async handler(input, ctx) {
    const { afterId, take } = pageParams(input);
    let query = filteredContacts(ctx.db.db, ctx.principal.workspaceId, input).select("c.id");
    // Newest first. New contacts get larger ids, so they never shift a later page.
    if (afterId !== null) query = query.where("c.id", "<", afterId);
    const rows = await query.orderBy("c.id", "desc").limit(take).execute();
    const page = rows.slice(0, input.limit);
    const items = await loadContacts(
      ctx.db.db,
      ctx.principal.workspaceId,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.id) : null,
    };
  },
});

export const contactsCount = defineOperation({
  id: "contacts.count",
  summary: "Count contacts",
  description: "Counts the contacts that match the filters, and the workspace total by status.",
  method: "get",
  path: "/contacts/count",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "A read that helps an agent size an audience." },
  input: z.object(contactFilterShape),
  output: z
    .object({
      matching: z.number().int(),
      total: z.number().int(),
      subscribed: z.number().int(),
      unsubscribed: z.number().int(),
      suppressed: z.number().int(),
    })
    .meta({ id: "ContactCounts" }),
  async handler(input, ctx) {
    const workspaceId = ctx.principal.workspaceId;
    // Each count reads every contact of the workspace. Without a filter the matching
    // count equals the total, so one query gives both.
    const filtered = hasContactFilters(input);
    const [matching, totals] = await Promise.all([
      filtered
        ? filteredContacts(ctx.db.db, workspaceId, input)
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow()
        : null,
      filteredContacts(ctx.db.db, workspaceId, {})
        .select((eb) => [
          eb.fn.countAll<number>().as("total"),
          eb.fn.count<number>("s.id").as("suppressed"),
          eb.fn
            .sum<number>(
              eb
                .case()
                .when(eb.and([eb("s.id", "is", null), eb("c.unsubscribed_at", "is not", null)]))
                .then(1)
                .else(0)
                .end(),
            )
            .as("unsubscribed"),
        ])
        .executeTakeFirstOrThrow(),
    ]);
    const total = Number(totals.total);
    const suppressed = Number(totals.suppressed);
    const unsubscribed = Number(totals.unsubscribed ?? 0);
    return {
      matching: matching === null ? total : Number(matching.count),
      total,
      suppressed,
      unsubscribed,
      subscribed: total - suppressed - unsubscribed,
    };
  },
});

export const contactsGet = defineOperation({
  id: "contacts.get",
  summary: "Get a contact",
  description: "Returns one contact with tags, list memberships, custom fields, and status.",
  method: "get",
  path: "/contacts/{id}",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "Contact get is in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({ id: ContactId }),
  output: ContactSchema,
  async handler(input, ctx) {
    return requireContact(ctx, input.id);
  },
});

export const contactsUpsert = defineOperation({
  id: "contacts.upsert",
  summary: "Create or update a contact by email",
  description:
    "Finds the contact by its email address (trimmed and lowercased) and creates it when " +
    "it does not exist. Adds the tags (created when missing) and subscribes to the lists. " +
    "Never reverses an unsubscribe or a suppression. An API key cannot raise a consent " +
    "basis of `unknown`: the call then succeeds and returns the warning " +
    "`consent_upgrade_blocked`. Use this to sync enrollments from another app.",
  method: "post",
  path: "/contacts",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "Contact upsert is in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({
    email: z.string().max(320),
    firstName: Name.nullable().optional(),
    lastName: Name.nullable().optional(),
    consentBasis: ConsentBasisSchema.optional().meta({
      description: "Basis for a new contact (default `unknown`), or a change for an existing one.",
    }),
    consentNote: z.string().trim().max(500).optional(),
    tags: TagNames.optional().meta({ description: "Tag names. Missing tags are created." }),
    listIds: z.array(z.number().int().positive()).max(20).optional(),
    fields: FieldsInput.optional(),
  }),
  output: z
    .object({
      contact: ContactSchema,
      created: z.boolean(),
      warnings: z.array(z.string()),
    })
    .meta({ id: "ContactUpsertResult" }),
  async handler(input, ctx) {
    const result = await upsertContact(ctx, input);
    return {
      contact: await requireContact(ctx, result.contactId),
      created: result.created,
      warnings: result.warnings,
    };
  },
  auditTarget: (_input, output) => ({
    targetType: "contact",
    targetId: output.contact.id,
    metadata: { created: output.created, warnings: output.warnings },
  }),
});

export const contactsUpdate = defineOperation({
  id: "contacts.update",
  summary: "Update a contact",
  description:
    "Changes names and custom fields. `unsubscribe: true` unsubscribes the contact from " +
    "every list and keeps it visible with the source and time. No call reverses an " +
    "unsubscribe. The contact resubscribes on the preference page.",
  method: "patch",
  path: "/contacts/{id}",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "Contact edits are part of contact upsert in the MCP 'now' set." },
  contactContent: true,
  input: z.object({
    id: ContactId,
    firstName: Name.nullable().optional(),
    lastName: Name.nullable().optional(),
    fields: FieldsInput.optional(),
    unsubscribe: z.literal(true).optional(),
  }),
  output: ContactSchema,
  async handler(input, ctx) {
    const { db, now, principal } = ctx;
    const workspaceId = principal.workspaceId;
    const contact = await requireContact(ctx, input.id);
    const source = actorSource(principal);
    const fieldEntries = Object.entries(input.fields ?? {});
    const fieldIds = await ensureFields(
      db.db,
      workspaceId,
      fieldEntries.map(([key]) => key),
    );

    const writes = [];
    const names: { first_name?: string | null; last_name?: string | null } = {};
    if (input.firstName !== undefined) names.first_name = input.firstName;
    if (input.lastName !== undefined) names.last_name = input.lastName;
    if (Object.keys(names).length > 0) {
      writes.push(
        db.db
          .updateTable("contacts")
          .set({ ...names, updated_at: now })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", contact.id),
      );
    }
    for (const [key, value] of fieldEntries) {
      const fieldId = fieldIds.get(key);
      if (fieldId !== undefined) {
        writes.push(
          ...setFieldValues(db.db, workspaceId, fieldId, [{ email: contact.email, value }], now),
        );
      }
    }
    if (input.unsubscribe && contact.unsubscribedAt === null) {
      writes.push(
        db.db
          .updateTable("contacts")
          .set({
            unsubscribed_at: now,
            unsubscribe_source: source,
            unsubscribe_campaign_id: null,
            updated_at: now,
          })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", contact.id)
          .where("unsubscribed_at", "is", null),
        db.db
          .updateTable("list_members")
          .set({
            status: "unsubscribed",
            status_source: source,
            status_at: now,
            status_campaign_id: null,
          })
          .where("workspace_id", "=", workspaceId)
          .where("contact_id", "=", contact.id)
          .where("status", "=", "subscribed"),
      );
    }
    await db.atomic(writes);
    return requireContact(ctx, contact.id);
  },
  auditTarget: (input, output) => ({
    targetType: "contact",
    targetId: output.id,
    metadata: input.unsubscribe ? { unsubscribe: true } : undefined,
  }),
});

export const contactsDelete = defineOperation({
  id: "contacts.delete",
  summary: "Delete a contact",
  description:
    "Deletes the contact, its tags, memberships, field values, and consent history. When " +
    "the contact had unsubscribed, a suppression (reason `erased`) keeps the address from " +
    "coming back through an import or an upsert. Unsubscribing keeps the contact, so use " +
    "`contacts.update` with `unsubscribe` for that.",
  method: "delete",
  path: "/contacts/{id}",
  scope: "contacts:delete",
  risk: "destructive",
  mcp: { class: "later", reason: "Erase is in the plan's MCP 'later' set." },
  input: z.object({ id: ContactId }),
  output: z.object({ id: z.number().int(), suppressed: z.boolean() }),
  async handler(input, ctx) {
    const { db, now, principal } = ctx;
    const workspaceId = principal.workspaceId;
    const contact = await requireContact(ctx, input.id);
    const unsubscribed =
      contact.unsubscribedAt !== null ||
      contact.lists.some((membership) => membership.status === "unsubscribed");
    const keepSuppressed = unsubscribed && contact.status !== "suppressed";
    const writes = [];
    if (keepSuppressed) {
      const emailHash = await requireService(ctx.services, "hashEmail")(contact.email);
      writes.push(
        db.db
          .insertInto("suppressions")
          .values({
            workspace_id: workspaceId,
            email_hash: emailHash,
            reason: "erased",
            source: `contact_deleted:${actorSource(principal)}`,
            campaign_id: null,
            created_at: now,
          })
          .onConflict((conflict) => conflict.doNothing()),
      );
    }
    // Foreign keys cascade to tags, memberships, field values, and consent events.
    writes.push(
      db.db
        .deleteFrom("contacts")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", contact.id),
    );
    await db.atomic(writes);
    return { id: contact.id, suppressed: keepSuppressed };
  },
  auditTarget: (_input, output) => ({
    targetType: "contact",
    targetId: output.id,
    metadata: { suppressed: output.suppressed },
  }),
});

export const contactsAddTags = defineOperation({
  id: "contacts.add_tags",
  summary: "Tag a contact",
  description: "Adds tags by name. Missing tags are created.",
  method: "post",
  path: "/contacts/{id}/tags",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "Tags are in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({ id: ContactId, tags: TagNames.min(1) }),
  output: ContactSchema,
  async handler(input, ctx) {
    const { db, now, principal } = ctx;
    const contact = await requireContact(ctx, input.id);
    const tags = await ensureTags(db.db, principal.workspaceId, input.tags, now);
    await db.atomic(
      tagContacts(
        db.db,
        principal.workspaceId,
        [contact.email],
        tags.map((tag) => tag.id),
        now,
      ),
    );
    return requireContact(ctx, contact.id);
  },
  auditTarget: (_input, output) => ({ targetType: "contact", targetId: output.id }),
});

export const contactsRemoveTag = defineOperation({
  id: "contacts.remove_tag",
  summary: "Remove a tag from a contact",
  method: "delete",
  path: "/contacts/{id}/tags/{tagId}",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "Tags are in the plan's MCP 'now' set." },
  contactContent: true,
  input: z.object({ id: ContactId, tagId: z.coerce.number().int().positive() }),
  output: ContactSchema,
  async handler(input, ctx) {
    const { db, principal } = ctx;
    const contact = await requireContact(ctx, input.id);
    await checkTags(db.db, principal.workspaceId, [input.tagId]);
    await db.db
      .deleteFrom("contact_tags")
      .where("workspace_id", "=", principal.workspaceId)
      .where("contact_id", "=", contact.id)
      .where("tag_id", "=", input.tagId)
      .execute();
    return requireContact(ctx, contact.id);
  },
  auditTarget: (_input, output) => ({ targetType: "contact", targetId: output.id }),
});

/** Finds a contact id by address, for tests and tools. Returns null when there is none. */
export async function findContactId(
  ctx: Pick<OperationContext, "db" | "principal">,
  email: string,
): Promise<number | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const row = await ctx.db.db
    .selectFrom("contacts")
    .select("id")
    .where("workspace_id", "=", ctx.principal.workspaceId)
    .where("email", "=", normalized)
    .executeTakeFirst();
  return row?.id ?? null;
}
