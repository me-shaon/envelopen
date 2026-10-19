import { z } from "zod";
import { actorSource, ConsentBasisSchema } from "../contacts/model";
import { changeConsent } from "../contacts/writes";
import { OperationError } from "../errors";
import { pageInputShape, pageOf, pageParams, toPage } from "../pagination";
import { defineOperation } from "../registry/operation";
import { consentDecision } from "./rules";

// Consent history (R16). Append-only: these operations read the history or append to
// it. Nothing updates or deletes a consent event.

const ConsentEventShape = z.object({
  id: z.number().int(),
  basis: ConsentBasisSchema,
  source: z.string(),
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.number().int(),
});

export const ConsentEventSchema = ConsentEventShape.meta({ id: "ConsentEvent" });

const ContactId = z.coerce.number().int().positive();

export const consentList = defineOperation({
  id: "consent.list",
  summary: "List a contact's consent history",
  description: "Returns the consent events of one contact, newest first.",
  method: "get",
  path: "/contacts/{id}/consent",
  scope: "contacts:read",
  risk: "read",
  mcp: { class: "now", reason: "A contact read. Agents need the basis to pick the campaign type." },
  contactContent: true,
  input: z.object({ id: ContactId, ...pageInputShape }),
  output: pageOf(ConsentEventSchema),
  async handler(input, { principal, db }) {
    const { afterId, take } = pageParams(input);
    let query = db.db
      .selectFrom("consent_events")
      .selectAll()
      .where("workspace_id", "=", principal.workspaceId)
      .where("contact_id", "=", input.id);
    if (afterId !== null) query = query.where("id", "<", afterId);
    const rows = await query.orderBy("id", "desc").limit(take).execute();
    return toPage(
      rows,
      input.limit,
      (row) => row.id,
      (row) => ({
        id: row.id,
        basis: row.basis,
        source: row.source,
        actorType: row.actor_type,
        actorId: row.actor_id,
        note: row.note,
        createdAt: row.created_at,
      }),
    );
  },
});

export const consentRecord = defineOperation({
  id: "consent.record",
  summary: "Record a new consent basis",
  description:
    "Changes a contact's consent basis and appends the event with a note. An API key " +
    "cannot change a basis of `unknown` to a stronger basis.",
  method: "post",
  path: "/contacts/{id}/consent",
  scope: "contacts:write",
  risk: "write",
  mcp: { class: "never", reason: "The plan keeps consent upgrades away from MCP." },
  input: z.object({
    id: ContactId,
    basis: ConsentBasisSchema,
    note: z.string().trim().max(500).optional(),
  }),
  output: ConsentEventShape.nullable().meta({
    description: "The new event, or null when the basis did not change.",
  }),
  async handler(input, { principal, db, now }) {
    const workspaceId = principal.workspaceId;
    const contact = await db.db
      .selectFrom("contacts")
      .select(["id", "consent_basis"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!contact) throw new OperationError("not_found", "The contact does not exist.");
    const decision = consentDecision(principal, contact.consent_basis, input.basis);
    if (decision === "blocked") {
      throw new OperationError(
        "forbidden",
        "An API key cannot change a consent basis of unknown. The owner records it in the app.",
      );
    }
    if (decision === "unchanged") return null;
    await db.atomic(
      changeConsent(db.db, workspaceId, [contact.id], {
        from: contact.consent_basis,
        to: input.basis,
        source: actorSource(principal),
        actorType: principal.actorType,
        actorId: principal.actorId,
        note: input.note ?? null,
        now,
      }),
    );
    const event = await db.db
      .selectFrom("consent_events")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", contact.id)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    return {
      id: event.id,
      basis: event.basis,
      source: event.source,
      actorType: event.actor_type,
      actorId: event.actor_id,
      note: event.note,
      createdAt: event.created_at,
    };
  },
  auditTarget: (input, output) => ({
    targetType: "contact",
    targetId: input.id,
    metadata: { basis: input.basis, changed: output !== null },
  }),
});
