import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { actorSource, contactBase, inIdList } from "./model";
import { contactFilterShape, filteredContacts } from "./query";
import { checkTags, ensureTags, TAG_NAME_MAX } from "./writes";

// One change to many contacts at once: add them to a list or a tag, or take them out.
// The owner selects contacts on the Contacts page, or selects every contact that matches
// the filters. Each change is one set-based statement, so its size does not depend on the
// number of contacts, and every query stays within D1's 100 bound parameters (KTD20).
//
// The same rules apply as for one contact:
// - An unsubscribed membership stays unsubscribed (R73). Adding to the list does not
//   subscribe the contact again, and removing from the list keeps the record (R64).
// - Adding to a list does not start the list's welcome series. A bulk change is for
//   contacts who are already in the workspace, so they get no welcome email.

/** Contacts that one call can select by id: more than the pages that a person loads. */
export const BULK_MAX_IDS = 500;

/**
 * Contacts that one call can change through the filters. D1 stops a query after 30
 * seconds, and each new membership also updates the stored count of the list or tag.
 */
export const BULK_MAX_MATCHED = 50_000;

export const BULK_ACTIONS = ["add_to_list", "remove_from_list", "add_tag", "remove_tag"] as const;

export type BulkAction = (typeof BULK_ACTIONS)[number];

const BulkInput = z.object({
  action: z.enum(BULK_ACTIONS).meta({
    description:
      "add_to_list and remove_from_list need listId. add_tag needs tagName, and creates a missing tag. remove_tag needs tagId.",
  }),
  listId: z.number().int().positive().optional(),
  tagName: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
  tagId: z.number().int().positive().optional(),
  contactIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(BULK_MAX_IDS)
    .optional()
    .meta({ description: "The selected contacts. Send this or filters, not both." }),
  filters: z.object(contactFilterShape).optional().meta({
    description:
      "Every contact that matches these filters, as on the contact list. An empty object selects every contact of the workspace.",
  }),
});

type BulkInputValue = z.output<typeof BulkInput>;

/** The selected contacts of the workspace, joined as `c`. Add a select. */
function selection(ctx: OperationContext, input: BulkInputValue) {
  const workspaceId = ctx.principal.workspaceId;
  if (input.contactIds) {
    return contactBase(ctx.db.db, workspaceId).where(
      inIdList("c.id", [...new Set(input.contactIds)]),
    );
  }
  return filteredContacts(ctx.db.db, workspaceId, input.filters ?? {});
}

async function count(query: { execute(): Promise<{ count: number | string | bigint }[]> }) {
  const [row] = await query.execute();
  return Number(row?.count ?? 0);
}

/** The list or tag that the action changes. Creates the tag for add_tag. */
async function target(ctx: OperationContext, input: BulkInputValue) {
  const { db, principal, now } = ctx;
  const workspaceId = principal.workspaceId;
  if (input.action === "add_to_list" || input.action === "remove_from_list") {
    if (input.listId === undefined) {
      throw new OperationError("invalid_input", "Select a list.");
    }
    const list = await db.db
      .selectFrom("lists")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.listId)
      .executeTakeFirst();
    if (!list) throw new OperationError("not_found", "The list does not exist.");
    return { kind: "list" as const, id: list.id };
  }
  if (input.action === "add_tag") {
    if (input.tagName === undefined) {
      throw new OperationError("invalid_input", "Type a tag name.");
    }
    const [tag] = await ensureTags(db.db, workspaceId, [input.tagName], now);
    if (!tag) throw new OperationError("invalid_input", "Type a tag name.");
    return { kind: "tag" as const, id: tag.id };
  }
  if (input.tagId === undefined) {
    throw new OperationError("invalid_input", "Select a tag.");
  }
  await checkTags(db.db, workspaceId, [input.tagId]);
  return { kind: "tag" as const, id: input.tagId };
}

export const contactsBulk = defineOperation({
  id: "contacts.bulk",
  summary: "Change the lists or tags of many contacts",
  description:
    "Adds the selected contacts to a list or a tag, or removes them from it. Select the " +
    `contacts by id (at most ${BULK_MAX_IDS}) or by the filters of the contact list (at most ` +
    `${BULK_MAX_MATCHED.toLocaleString("en-US")} matches). A contact who unsubscribed from ` +
    "the list stays unsubscribed, and removing from a list keeps that record. Adding to a " +
    "list does not start its welcome series.",
  method: "post",
  path: "/contacts/bulk",
  scope: "contacts:write",
  risk: "write",
  mcp: {
    class: "later",
    reason:
      "A filter can select every contact of the workspace. The owner makes such a change in the app first.",
  },
  input: BulkInput,
  output: z
    .object({
      matched: z.number().int().meta({ description: "The selected contacts that exist." }),
      changed: z.number().int().meta({
        description: "The contacts that the action added or removed. The others had it already.",
      }),
      listId: z.number().int().nullable(),
      tagId: z.number().int().nullable(),
    })
    .meta({ id: "BulkContactsResult" }),
  async handler(input, ctx) {
    if ((input.contactIds === undefined) === (input.filters === undefined)) {
      throw new OperationError("invalid_input", "Send contactIds or filters, not both.");
    }
    const { db, principal, now } = ctx;
    const workspaceId = principal.workspaceId;
    const goal = await target(ctx, input);

    const matched = await count(
      selection(ctx, input).select((eb) => eb.fn.countAll<number>().as("count")),
    );
    if (input.filters && matched > BULK_MAX_MATCHED) {
      throw new OperationError(
        "invalid_input",
        `The filters match ${matched.toLocaleString("en-US")} contacts. One change can include at most ${BULK_MAX_MATCHED.toLocaleString("en-US")}. Narrow the filters, and repeat for the rest.`,
      );
    }
    const ids = () => selection(ctx, input).select("c.id");
    const result = (changed: number) => ({
      matched,
      changed,
      listId: goal.kind === "list" ? goal.id : null,
      tagId: goal.kind === "tag" ? goal.id : null,
    });
    if (matched === 0) return result(0);

    // D1 counts the rows that the member count triggers write in meta.changes, so the
    // change is counted before the write.
    switch (input.action) {
      case "add_to_list": {
        const existing = await count(
          db.db
            .selectFrom("list_members")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("workspace_id", "=", workspaceId)
            .where("list_id", "=", goal.id)
            .where("contact_id", "in", ids()),
        );
        const source = actorSource(principal);
        await db.db
          .insertInto("list_members")
          .columns([
            "workspace_id",
            "list_id",
            "contact_id",
            "status",
            "status_source",
            "status_at",
            "status_campaign_id",
            "created_at",
          ])
          .expression(
            selection(ctx, input).select([
              sql<number>`${workspaceId}`.as("workspace_id"),
              sql<number>`${goal.id}`.as("list_id"),
              "c.id as contact_id",
              sql<string>`'subscribed'`.as("status"),
              sql<string>`${source}`.as("status_source"),
              sql<number>`${now}`.as("status_at"),
              sql<null>`NULL`.as("status_campaign_id"),
              sql<number>`${now}`.as("created_at"),
            ]),
          )
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        return result(matched - existing);
      }
      case "remove_from_list": {
        const members = db.db
          .selectFrom("list_members")
          .where("workspace_id", "=", workspaceId)
          .where("list_id", "=", goal.id)
          .where("status", "=", "subscribed")
          .where("contact_id", "in", ids());
        const removable = await count(members.select((eb) => eb.fn.countAll<number>().as("count")));
        await db.db
          .deleteFrom("list_members")
          .where("workspace_id", "=", workspaceId)
          .where("list_id", "=", goal.id)
          .where("status", "=", "subscribed")
          .where("contact_id", "in", ids())
          .execute();
        return result(removable);
      }
      case "add_tag": {
        const existing = await count(
          db.db
            .selectFrom("contact_tags")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("workspace_id", "=", workspaceId)
            .where("tag_id", "=", goal.id)
            .where("contact_id", "in", ids()),
        );
        await db.db
          .insertInto("contact_tags")
          .columns(["workspace_id", "contact_id", "tag_id", "created_at"])
          .expression(
            selection(ctx, input).select([
              sql<number>`${workspaceId}`.as("workspace_id"),
              "c.id as contact_id",
              sql<number>`${goal.id}`.as("tag_id"),
              sql<number>`${now}`.as("created_at"),
            ]),
          )
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        return result(matched - existing);
      }
      case "remove_tag": {
        const removable = await count(
          db.db
            .selectFrom("contact_tags")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("workspace_id", "=", workspaceId)
            .where("tag_id", "=", goal.id)
            .where("contact_id", "in", ids()),
        );
        await db.db
          .deleteFrom("contact_tags")
          .where("workspace_id", "=", workspaceId)
          .where("tag_id", "=", goal.id)
          .where("contact_id", "in", ids())
          .execute();
        return result(removable);
      }
    }
  },
  auditTarget: (input, output) => ({
    targetType: output.listId !== null ? "list" : "tag",
    targetId: output.listId ?? output.tagId ?? undefined,
    metadata: {
      action: input.action,
      selectedBy: input.contactIds ? "ids" : "filters",
      matched: output.matched,
      changed: output.changed,
    },
  }),
});
