import { z } from "zod";
import { normalizeEmail } from "../contacts/email";
import { actorSource } from "../contacts/model";
import { chunk } from "../contacts/writes";
import { OperationError } from "../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { defineOperation } from "../registry/operation";
import { requireService } from "../services";

// The suppression list (R19). Rows store a keyed hash of the normalized address, never
// the address. The list shows the address only when a contact with that hash exists.
// Envelopen never sends to a suppressed address, and imports skip it.
//
// Reads need stats:read, as the plan's scope table says. A manual block needs
// contacts:write. Removing a suppression lets email reach the address again, so only
// the owner's session can do it.

const REASONS = ["hard_bounce", "complaint", "soft_bounce_limit", "manual", "erased"] as const;

export const SuppressionSchema = z
  .object({
    id: z.number().int(),
    reason: z.enum(REASONS),
    source: z.string().nullable(),
    campaignId: z.number().int().nullable(),
    contactId: z.number().int().nullable(),
    email: z
      .string()
      .nullable()
      .meta({ description: "The address of the matching contact, or null when none exists." }),
    createdAt: z.number().int(),
  })
  .meta({ id: "Suppression" });

export const suppressionsList = defineOperation({
  id: "suppressions.list",
  summary: "List suppressions",
  description: "Returns the suppression list, newest first. Pass `email` to check one address.",
  method: "get",
  path: "/suppressions",
  scope: "stats:read",
  risk: "read",
  mcp: { class: "now", reason: "Read access to suppression is in the plan's MCP 'now' set." },
  input: z.object({
    email: z.string().max(320).optional(),
    reason: z.enum(REASONS).optional(),
    ...pageInputShape,
  }),
  output: pageOf(SuppressionSchema),
  async handler(input, ctx) {
    const { principal, db } = ctx;
    const workspaceId = principal.workspaceId;
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("suppressions as s")
      .leftJoin("contacts as c", (join) =>
        join.onRef("c.email_hash", "=", "s.email_hash").on("c.workspace_id", "=", workspaceId),
      )
      .select([
        "s.id",
        "s.reason",
        "s.source",
        "s.campaign_id",
        "s.created_at",
        "c.id as contact_id",
        "c.email",
      ])
      .where("s.workspace_id", "=", workspaceId);
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      if (!email) throw new OperationError("invalid_input", "The email address is not valid.");
      const hash = await requireService(ctx.services, "hashEmail")(email);
      query = query.where("s.email_hash", "=", hash);
    }
    if (input.reason) query = query.where("s.reason", "=", input.reason);
    if (afterId !== null) query = query.where("s.id", "<", afterId);
    const rows = await query.orderBy("s.id", "desc").limit(take).execute();
    return toPage(
      rows,
      input.limit,
      (row) => row.id,
      (row) => ({
        id: row.id,
        reason: row.reason,
        source: row.source,
        campaignId: row.campaign_id,
        contactId: row.contact_id,
        email: row.email,
        createdAt: row.created_at,
      }),
    );
  },
});

export const suppressionsAdd = defineOperation({
  id: "suppressions.add",
  summary: "Suppress addresses",
  description:
    "Adds up to 100 addresses to the suppression list as manual blocks. An address that " +
    "is suppressed already keeps its first reason. Contacts with these addresses stay, " +
    "with the status suppressed.",
  method: "post",
  path: "/suppressions",
  scope: "contacts:write",
  risk: "write",
  mcp: {
    class: "later",
    reason: "The plan gives MCP read access to suppression in v1. Writes come later.",
  },
  input: z.object({ emails: z.array(z.string().max(320)).min(1).max(100) }),
  output: z
    .object({
      added: z.number().int(),
      alreadySuppressed: z.number().int(),
      invalid: z.array(z.string()),
    })
    .meta({ id: "SuppressionAddResult" }),
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const hashEmail = requireService(ctx.services, "hashEmail");
    const invalid: string[] = [];
    const hashes = new Set<string>();
    for (const raw of input.emails) {
      const email = normalizeEmail(raw);
      if (email) hashes.add(await hashEmail(email));
      else invalid.push(raw);
    }
    const source = actorSource(principal);
    const results = await db.atomic(
      chunk([...hashes], 16).map((part) =>
        db.db
          .insertInto("suppressions")
          .values(
            part.map((hash) => ({
              workspace_id: principal.workspaceId,
              email_hash: hash,
              reason: "manual" as const,
              source,
              campaign_id: null,
              created_at: now,
            })),
          )
          .onConflict((conflict) => conflict.doNothing()),
      ),
    );
    const added = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
    return { added, alreadySuppressed: hashes.size - added, invalid };
  },
  auditTarget: (_input, output) => ({
    targetType: "suppression",
    metadata: { added: output.added },
  }),
});

export const suppressionsRemove = defineOperation({
  id: "suppressions.remove",
  summary: "Remove a suppression",
  description:
    "Lets email reach the address again. Owner session only: a bounce or a complaint is " +
    "a deliverability and legal signal that no key or agent can clear.",
  method: "delete",
  path: "/suppressions/{id}",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: { class: "never", reason: "Clearing a suppression is an owner decision." },
  input: z.object({ id: z.coerce.number().int().positive() }),
  output: z.object({ id: z.number().int(), reason: z.enum(REASONS) }),
  async handler(input, { principal, db }) {
    const row = await db.db
      .selectFrom("suppressions")
      .select(["id", "reason"])
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "The suppression does not exist.");
    await db.db
      .deleteFrom("suppressions")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .execute();
    return row;
  },
  auditTarget: (_input, output) => ({
    targetType: "suppression",
    targetId: output.id,
    metadata: { reason: output.reason },
  }),
});
