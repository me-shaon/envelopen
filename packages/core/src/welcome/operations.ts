import type { Database, DbConnection, Row } from "@envelopen/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { checkCampaignPolicy } from "../connections/policy-gate";
import { normalizeEmail } from "../contacts/email";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { testLinkOrigin, verifiedTrackingDomain } from "../templates/preview";
import {
  MAX_WELCOME_STEPS,
  parseSteps,
  SERIES_NAME_MAX,
  type SeriesOverlap,
  type StepStats,
  toSeries,
  type WelcomeSeries,
  WelcomeSeriesSchema,
  WelcomeStepSchema,
} from "./model";

// The welcome series operations (U10, R15). Reads need campaigns:read. Edits of the
// steps and the sender need campaigns:write, as campaign drafts do. Turning a series on
// sends email to every new subscriber of the list without a further check, so it needs
// campaigns:send and is an external send. A new series is off.

const Id = z.coerce.number().int().positive();

const SeriesInputShape = {
  name: z.string().trim().min(1).max(SERIES_NAME_MAX),
  steps: z.array(WelcomeStepSchema).min(1).max(MAX_WELCOME_STEPS).meta({
    description: "1 to 5 steps in send order.",
  }),
  fromName: z.string().trim().max(100).nullable().default(null),
  fromEmail: z.string().trim().max(320).nullable().default(null).meta({
    description: "On a sending domain of the workspace. Null uses noreply@ the first verified one.",
  }),
  replyTo: z.string().trim().max(320).nullable().default(null),
};

async function getRow(db: Kysely<Database>, workspaceId: number, id: number) {
  const row = await db
    .selectFrom("welcome_series")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "The welcome series does not exist.");
  return row;
}

/** Send results per step position of each series. */
async function stepStats(
  db: DbConnection,
  workspaceId: number,
  seriesIds: readonly number[],
): Promise<Map<number, StepStats[]>> {
  const out = new Map<number, StepStats[]>();
  if (seriesIds.length === 0) return out;
  const rows = await db.db
    .selectFrom("welcome_sends")
    .select(["series_id", "position", "status", (eb) => eb.fn.countAll<number>().as("n")])
    .where("workspace_id", "=", workspaceId)
    .where("series_id", "in", [...seriesIds])
    .groupBy(["series_id", "position", "status"])
    .execute();
  for (const row of rows) {
    const list = out.get(row.series_id) ?? [];
    let entry = list.find((item) => item.position === row.position);
    if (!entry) {
      entry = { position: row.position, sent: 0, failed: 0, skipped: 0, pending: 0 };
      list.push(entry);
    }
    entry[row.status] += Number(row.n);
    out.set(row.series_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position);
  return out;
}

/**
 * The series lists that share subscribed contacts with `listId`, with the count. A
 * contact on two lists with a series gets both series.
 */
export async function seriesOverlaps(
  db: DbConnection,
  workspaceId: number,
  listId: number,
  exceptSeriesId?: number,
): Promise<SeriesOverlap[]> {
  const { rows } = await sql<{
    series_id: number;
    list_id: number;
    list_name: string;
    shared: number;
  }>`SELECT s.id AS series_id, s.list_id, l.name AS list_name,
  (SELECT COUNT(*) FROM list_members a JOIN list_members b
     ON b.workspace_id = ${workspaceId} AND b.contact_id = a.contact_id AND b.list_id = s.list_id AND b.status = 'subscribed'
   WHERE a.workspace_id = ${workspaceId} AND a.list_id = ${listId} AND a.status = 'subscribed') AS shared
FROM welcome_series s JOIN lists l ON l.workspace_id = ${workspaceId} AND l.id = s.list_id
WHERE s.workspace_id = ${workspaceId} AND s.list_id <> ${listId} AND s.id <> ${exceptSeriesId ?? 0}
ORDER BY s.id`.execute(db.db);
  return rows
    .filter((row) => Number(row.shared) > 0)
    .map((row) => ({
      seriesId: row.series_id,
      listId: row.list_id,
      listName: row.list_name,
      sharedContacts: Number(row.shared),
    }));
}

async function present(
  db: DbConnection,
  workspaceId: number,
  row: Row<"welcome_series">,
): Promise<WelcomeSeries> {
  const stats = await stepStats(db, workspaceId, [row.id]);
  const overlaps = await seriesOverlaps(db, workspaceId, row.list_id, row.id);
  return toSeries(row, stats.get(row.id) ?? [], overlaps);
}

type SeriesInput = {
  [K in keyof typeof SeriesInputShape]: z.output<(typeof SeriesInputShape)[K]>;
};

/** Checks the values of a create or an update and returns them in their stored form. */
async function cleanInput(ctx: OperationContext, input: SeriesInput) {
  const db = ctx.db.db;
  const workspaceId = ctx.principal.workspaceId;
  const templateIds = [...new Set(input.steps.map((step) => step.templateId))];
  const templates = await db
    .selectFrom("templates")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", templateIds)
    .execute();
  if (templates.length !== templateIds.length) {
    throw new OperationError("not_found", "A template of a step does not exist.", {
      field: "steps",
    });
  }
  let fromEmail: string | null = null;
  let domain: { tracking_domain: string | null; tracking_status: string } | undefined;
  if (input.fromEmail) {
    fromEmail = normalizeEmail(input.fromEmail);
    const host = fromEmail?.split("@")[1];
    domain = host
      ? await db
          .selectFrom("sending_domains")
          .select(["tracking_domain", "tracking_status"])
          .where("workspace_id", "=", workspaceId)
          .where("domain", "=", host)
          .executeTakeFirst()
      : undefined;
    if (!fromEmail || !domain) {
      throw new OperationError(
        "invalid_input",
        "The From address must be on a sending domain of this workspace.",
        { field: "fromEmail" },
      );
    }
  }
  let replyTo: string | null = null;
  if (input.replyTo) {
    replyTo = normalizeEmail(input.replyTo);
    if (!replyTo) {
      throw new OperationError("invalid_input", "The reply-to address is not valid.", {
        field: "replyTo",
      });
    }
  }
  return {
    name: input.name,
    steps: JSON.stringify(input.steps),
    from_name: input.fromName?.replaceAll(/["<>\r\n]/g, "").trim() || null,
    from_email: fromEmail,
    reply_to: replyTo,
    // The unsubscribe links go to the app's host unless a tracking domain is verified.
    link_origin: testLinkOrigin(ctx.services.appOrigin, verifiedTrackingDomain(domain)),
  };
}

export const welcomeSeriesList = defineOperation({
  id: "welcome_series.list",
  summary: "List welcome series",
  description:
    "Returns every welcome series of the workspace with its steps, the contacts that " +
    "started it, the send results per step, and the series lists that share contacts.",
  method: "get",
  path: "/welcome-series",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "A read. An agent can report what each series sends." },
  input: z.object({}),
  output: z.object({ items: z.array(WelcomeSeriesSchema) }).meta({ id: "WelcomeSeriesList" }),
  async handler(_input, { principal, db }) {
    const rows = await db.db
      .selectFrom("welcome_series")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .orderBy("id", "asc")
      .limit(200)
      .execute();
    const stats = await stepStats(
      db,
      principal.workspaceId,
      rows.map((row) => row.id),
    );
    const items = [];
    for (const row of rows) {
      const overlaps = await seriesOverlaps(db, principal.workspaceId, row.list_id, row.id);
      items.push(toSeries(row, stats.get(row.id) ?? [], overlaps));
    }
    return { items };
  },
});

export const welcomeSeriesGet = defineOperation({
  id: "welcome_series.get",
  summary: "Get a welcome series",
  method: "get",
  path: "/welcome-series/{id}",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "A read. An agent can report what a series sends." },
  input: z.object({ id: Id }),
  output: WelcomeSeriesSchema,
  async handler(input, { principal, db }) {
    return present(db, principal.workspaceId, await getRow(db.db, principal.workspaceId, input.id));
  },
});

export const welcomeSeriesOverlaps = defineOperation({
  id: "welcome_series.overlaps",
  summary: "Check list overlap for a welcome series",
  description:
    "Returns the other series whose list shares subscribed contacts with `listId`. A " +
    "shared contact gets both series.",
  method: "get",
  path: "/welcome-series/overlaps",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "A read that helps an agent choose a list." },
  input: z.object({ listId: Id, seriesId: Id.optional() }),
  output: z
    .object({ items: WelcomeSeriesSchema.shape.overlaps })
    .meta({ id: "WelcomeSeriesOverlaps" }),
  async handler(input, { principal, db }) {
    return {
      items: await seriesOverlaps(db, principal.workspaceId, input.listId, input.seriesId),
    };
  },
});

export const welcomeSeriesCreate = defineOperation({
  id: "welcome_series.create",
  summary: "Create a welcome series",
  description:
    "Creates the welcome series of a list: 1 to 5 emails, each with a template, a " +
    "subject, and a delay (R15). A list has at most one series. A new series is off " +
    "until `welcome_series.set_enabled` turns it on.",
  method: "post",
  path: "/welcome-series",
  scope: "campaigns:write",
  risk: "write",
  mcp: { class: "now", reason: "A new series is off, as a campaign draft is." },
  successStatus: 201,
  input: z.object({ listId: z.number().int().positive(), ...SeriesInputShape }),
  output: WelcomeSeriesSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const workspaceId = principal.workspaceId;
    const list = await db.db
      .selectFrom("lists")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.listId)
      .executeTakeFirst();
    if (!list) throw new OperationError("not_found", "The list does not exist.");
    const taken = await db.db
      .selectFrom("welcome_series")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("list_id", "=", input.listId)
      .executeTakeFirst();
    if (taken) {
      throw new OperationError("conflict", "This list has a welcome series already.", {
        seriesId: taken.id,
      });
    }
    const values = await cleanInput(ctx, input);
    const row = await db.db
      .insertInto("welcome_series")
      .values({
        workspace_id: workspaceId,
        list_id: input.listId,
        ...values,
        enabled: 0,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return present(db, workspaceId, row);
  },
  auditTarget: (_input, output) => ({
    targetType: "welcome_series",
    targetId: output.id,
    metadata: { listId: output.listId, steps: output.steps.length },
  }),
});

export const welcomeSeriesUpdate = defineOperation({
  id: "welcome_series.update",
  summary: "Change a welcome series",
  description:
    "Replaces the name, the steps, and the sender. The Workflow reads each step when it " +
    "is due, so the change applies to the steps that have not run yet. A contact that got " +
    "step 2 gets the new step 3 next.",
  method: "put",
  path: "/welcome-series/{id}",
  scope: "campaigns:write",
  risk: "write",
  mcp: { class: "now", reason: "An edit of content, as a campaign draft edit is." },
  input: z.object({ id: Id, ...SeriesInputShape }),
  output: WelcomeSeriesSchema,
  async handler(input, ctx) {
    const { principal, db, now } = ctx;
    const workspaceId = principal.workspaceId;
    await getRow(db.db, workspaceId, input.id);
    const values = await cleanInput(ctx, input);
    const row = await db.db
      .updateTable("welcome_series")
      .set({ ...values, updated_at: now })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return present(db, workspaceId, row);
  },
  auditTarget: (input, output) => ({
    targetType: "welcome_series",
    targetId: input.id,
    metadata: { steps: output.steps.length, enabled: output.enabled },
  }),
});

export const welcomeSeriesSetEnabled = defineOperation({
  id: "welcome_series.set_enabled",
  summary: "Turn a welcome series on or off",
  description:
    "On: each new subscriber of the list who joins through a confirmed form signup, or " +
    "through an add with `startWelcome`, gets the series. Off: no new contact starts it, " +
    "and running contacts stop at their next step.",
  method: "post",
  path: "/welcome-series/{id}/enabled",
  scope: "campaigns:send",
  risk: "external_send",
  mcp: {
    class: "later",
    reason:
      "A series that is on sends email to each new subscriber without a further check. Only the owner turns it on for now.",
  },
  input: z.object({ id: Id, enabled: z.boolean() }),
  output: WelcomeSeriesSchema,
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    const current = await getRow(db.db, workspaceId, input.id);
    if (input.enabled) {
      if (parseSteps(current.steps).length === 0) {
        throw new OperationError("invalid_input", "Add at least one step before you turn it on.");
      }
      const policy = await checkCampaignPolicy(db, workspaceId);
      if (!policy.allowed) throw new OperationError("conflict", policy.message, policy);
    }
    const row = await db.db
      .updateTable("welcome_series")
      .set({ enabled: input.enabled ? 1 : 0, updated_at: now })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return present(db, workspaceId, row);
  },
  auditTarget: (input) => ({
    targetType: "welcome_series",
    targetId: input.id,
    metadata: { enabled: input.enabled },
  }),
});

export const welcomeSeriesDelete = defineOperation({
  id: "welcome_series.delete",
  summary: "Delete a welcome series",
  description:
    "Deletes the series and its send records. Contacts in the series stop at their next step.",
  method: "delete",
  path: "/welcome-series/{id}",
  scope: "campaigns:write",
  risk: "destructive",
  mcp: { class: "later", reason: "A delete removes the send history. Owner only for now." },
  input: z.object({ id: Id }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    const result = await db.db
      .deleteFrom("welcome_series")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) {
      throw new OperationError("not_found", "The welcome series does not exist.");
    }
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "welcome_series", targetId: output.id }),
});
