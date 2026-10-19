import type { Database } from "@envelopen/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { actorSource } from "../contacts/model";
import { chunk, cleanTagNames, TAG_NAME_MAX } from "../contacts/writes";
import { OperationError } from "../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { defineOperation } from "../registry/operation";

// Lists, tags, and list membership (R14, R64). Managing lists and tags needs
// lists:write. Changing a contact's membership needs contacts:write, as the plan's
// scope table says. Deletes are "later" for MCP, like the other destructive operations.

const Id = z.coerce.number().int().positive();
const ListName = z.string().trim().min(1).max(100);

export const ListSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string().nullable(),
    subscribed: z.number().int().meta({ description: "Members with status subscribed." }),
    unsubscribed: z.number().int().meta({ description: "Members who unsubscribed." }),
    createdAt: z.number().int(),
  })
  .meta({ id: "List" });

export const TagSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    contacts: z.number().int(),
    createdAt: z.number().int(),
  })
  .meta({ id: "Tag" });

function listsWithCounts(db: Kysely<Database>, workspaceId: number) {
  return db
    .selectFrom("lists as l")
    .leftJoin("list_members as m", (join) =>
      join.onRef("m.list_id", "=", "l.id").on("m.workspace_id", "=", workspaceId),
    )
    .select((eb) => [
      "l.id",
      "l.name",
      "l.description",
      "l.created_at",
      eb.fn
        .sum<number>(eb.case().when("m.status", "=", "subscribed").then(1).else(0).end())
        .as("subscribed"),
      eb.fn
        .sum<number>(eb.case().when("m.status", "=", "unsubscribed").then(1).else(0).end())
        .as("unsubscribed"),
    ])
    .where("l.workspace_id", "=", workspaceId)
    .groupBy("l.id");
}

type ListRow = {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
  subscribed: number | null;
  unsubscribed: number | null;
};

function toList(row: ListRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    subscribed: Number(row.subscribed ?? 0),
    unsubscribed: Number(row.unsubscribed ?? 0),
    createdAt: row.created_at,
  };
}

async function getList(db: Kysely<Database>, workspaceId: number, id: number) {
  const row = await listsWithCounts(db, workspaceId).where("l.id", "=", id).executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The list does not exist.");
  return toList(row);
}

export const listsList = defineOperation({
  id: "lists.list",
  summary: "List lists",
  description:
    "Returns the lists with their subscribed and unsubscribed member counts, oldest first.",
  method: "get",
  path: "/lists",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "Lists are in the plan's MCP 'now' set." },
  input: z.object(pageInputShape),
  output: pageOf(ListSchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = listsWithCounts(db.db, principal.workspaceId);
    if (afterId !== null) query = query.where("l.id", ">", afterId);
    const rows = await query.orderBy("l.id", "asc").limit(take).execute();
    return toPage(rows, input.limit, (row) => row.id, toList);
  },
});

export const listsCreate = defineOperation({
  id: "lists.create",
  summary: "Create a list",
  method: "post",
  path: "/lists",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Lists are in the plan's MCP 'now' set." },
  input: z.object({
    name: ListName,
    description: z.string().trim().max(500).nullable().optional(),
  }),
  output: ListSchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    const row = await db.db
      .insertInto("lists")
      .values({
        workspace_id: principal.workspaceId,
        name: input.name,
        description: input.description ?? null,
        created_at: now,
        updated_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return getList(db.db, principal.workspaceId, row.id);
  },
  auditTarget: (_input, output) => ({ targetType: "list", targetId: output.id }),
});

export const listsUpdate = defineOperation({
  id: "lists.update",
  summary: "Rename or describe a list",
  method: "patch",
  path: "/lists/{id}",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Lists are in the plan's MCP 'now' set." },
  input: z.object({
    id: Id,
    name: ListName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
  }),
  output: ListSchema,
  async handler(input, { principal, db, now }) {
    await getList(db.db, principal.workspaceId, input.id);
    await db.db
      .updateTable("lists")
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updated_at: now,
      })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return getList(db.db, principal.workspaceId, input.id);
  },
  auditTarget: (_input, output) => ({ targetType: "list", targetId: output.id }),
});

export const listsDelete = defineOperation({
  id: "lists.delete",
  summary: "Delete a list",
  description:
    "Deletes the list and its memberships. The contacts stay, with their tags and any " +
    "unsubscribe from every list.",
  method: "delete",
  path: "/lists/{id}",
  scope: "lists:write",
  risk: "destructive",
  mcp: { class: "later", reason: "Destructive. Deletes join MCP with the human-approval mode." },
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    await getList(db.db, principal.workspaceId, input.id);
    await db.db
      .deleteFrom("lists")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "list", targetId: output.id }),
});

export const listsAddContacts = defineOperation({
  id: "lists.add_contacts",
  summary: "Subscribe contacts to a list",
  description:
    "Subscribes up to 100 contacts. A contact who unsubscribed from the list stays " +
    "unsubscribed, and no call reverses that (R73).",
  method: "post",
  path: "/lists/{id}/contacts",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "List membership is in the plan's MCP 'now' set." },
  input: z.object({ id: Id, contactIds: z.array(z.number().int().positive()).min(1).max(100) }),
  output: z.object({
    added: z.number().int().meta({ description: "New memberships." }),
    keptUnsubscribed: z.number().int(),
  }),
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    await getList(db.db, workspaceId, input.id);
    const ids = [...new Set(input.contactIds)];
    const found = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("id", "in", ids)
      .execute();
    if (found.length !== ids.length) {
      throw new OperationError("not_found", "A contact does not exist in this workspace.");
    }
    const kept = await db.db
      .selectFrom("list_members")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("list_id", "=", input.id)
      .where("contact_id", "in", ids)
      .where("status", "=", "unsubscribed")
      .executeTakeFirstOrThrow();
    const source = actorSource(principal);
    const results = await db.atomic(
      chunk(ids, 12).map((part) =>
        db.db
          .insertInto("list_members")
          .values(
            part.map((contactId) => ({
              workspace_id: workspaceId,
              list_id: input.id,
              contact_id: contactId,
              status: "subscribed" as const,
              status_source: source,
              status_at: now,
              status_campaign_id: null,
              created_at: now,
            })),
          )
          .onConflict((conflict) => conflict.doNothing()),
      ),
    );
    const added = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
    return { added, keptUnsubscribed: Number(kept.count) };
  },
  auditTarget: (input, output) => ({
    targetType: "list",
    targetId: input.id,
    metadata: { added: output.added },
  }),
});

export const listsRemoveContact = defineOperation({
  id: "lists.remove_contact",
  summary: "Remove a contact from a list",
  description:
    "Removes a subscribed membership. An unsubscribed membership stays as the record of " +
    "the unsubscribe (R64), so this call leaves it in place.",
  method: "delete",
  path: "/lists/{id}/contacts/{contactId}",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "now", reason: "List membership is in the plan's MCP 'now' set." },
  input: z.object({ id: Id, contactId: Id }),
  output: z.object({ removed: z.boolean() }),
  async handler(input, { principal, db }) {
    const result = await db.db
      .deleteFrom("list_members")
      .where("workspace_id", "=", principal.workspaceId)
      .where("list_id", "=", input.id)
      .where("contact_id", "=", input.contactId)
      .where("status", "=", "subscribed")
      .executeTakeFirst();
    return { removed: Number(result.numDeletedRows) > 0 };
  },
  auditTarget: (input) => ({
    targetType: "list",
    targetId: input.id,
    metadata: { contactId: input.contactId },
  }),
});

// Tags -----------------------------------------------------------------------------------

function tagsWithCounts(db: Kysely<Database>, workspaceId: number) {
  return db
    .selectFrom("tags as t")
    .leftJoin("contact_tags as ct", (join) =>
      join.onRef("ct.tag_id", "=", "t.id").on("ct.workspace_id", "=", workspaceId),
    )
    .select((eb) => [
      "t.id",
      "t.name",
      "t.created_at",
      eb.fn.count<number>("ct.contact_id").as("contacts"),
    ])
    .where("t.workspace_id", "=", workspaceId)
    .groupBy("t.id");
}

function toTag(row: { id: number; name: string; created_at: number; contacts: number }) {
  return { id: row.id, name: row.name, contacts: Number(row.contacts), createdAt: row.created_at };
}

async function getTag(db: Kysely<Database>, workspaceId: number, id: number) {
  const row = await tagsWithCounts(db, workspaceId).where("t.id", "=", id).executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The tag does not exist.");
  return toTag(row);
}

async function assertTagNameFree(
  db: Kysely<Database>,
  workspaceId: number,
  name: string,
  exceptId?: number,
) {
  let query = db
    .selectFrom("tags")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase()));
  if (exceptId !== undefined) query = query.where("id", "!=", exceptId);
  if (await query.executeTakeFirst()) {
    throw new OperationError("conflict", `A tag named "${name}" exists already.`);
  }
}

const TagName = z.string().trim().min(1).max(TAG_NAME_MAX);

export const tagsList = defineOperation({
  id: "tags.list",
  summary: "List tags",
  description: "Returns the tags with their contact counts, oldest first.",
  method: "get",
  path: "/tags",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "Tags are in the plan's MCP 'now' set." },
  input: z.object(pageInputShape),
  output: pageOf(TagSchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = tagsWithCounts(db.db, principal.workspaceId);
    if (afterId !== null) query = query.where("t.id", ">", afterId);
    const rows = await query.orderBy("t.id", "asc").limit(take).execute();
    return toPage(rows, input.limit, (row) => row.id, toTag);
  },
});

export const tagsCreate = defineOperation({
  id: "tags.create",
  summary: "Create a tag",
  method: "post",
  path: "/tags",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Tags are in the plan's MCP 'now' set." },
  input: z.object({ name: TagName }),
  output: TagSchema,
  successStatus: 201,
  async handler(input, { principal, db, now }) {
    const [name = input.name] = cleanTagNames([input.name]);
    await assertTagNameFree(db.db, principal.workspaceId, name);
    const row = await db.db
      .insertInto("tags")
      .values({ workspace_id: principal.workspaceId, name, created_at: now })
      .returning("id")
      .executeTakeFirstOrThrow();
    return getTag(db.db, principal.workspaceId, row.id);
  },
  auditTarget: (_input, output) => ({ targetType: "tag", targetId: output.id }),
});

export const tagsRename = defineOperation({
  id: "tags.rename",
  summary: "Rename a tag",
  method: "patch",
  path: "/tags/{id}",
  scope: "lists:write",
  risk: "write",
  mcp: { class: "now", reason: "Tags are in the plan's MCP 'now' set." },
  input: z.object({ id: Id, name: TagName }),
  output: TagSchema,
  async handler(input, { principal, db }) {
    await getTag(db.db, principal.workspaceId, input.id);
    await assertTagNameFree(db.db, principal.workspaceId, input.name, input.id);
    await db.db
      .updateTable("tags")
      .set({ name: input.name })
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return getTag(db.db, principal.workspaceId, input.id);
  },
  auditTarget: (_input, output) => ({ targetType: "tag", targetId: output.id }),
});

export const tagsDelete = defineOperation({
  id: "tags.delete",
  summary: "Delete a tag",
  description: "Deletes the tag and removes it from every contact. The contacts stay.",
  method: "delete",
  path: "/tags/{id}",
  scope: "lists:write",
  risk: "destructive",
  mcp: { class: "later", reason: "Destructive. Deletes join MCP with the human-approval mode." },
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    await getTag(db.db, principal.workspaceId, input.id);
    await db.db
      .deleteFrom("tags")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "tag", targetId: output.id }),
});
