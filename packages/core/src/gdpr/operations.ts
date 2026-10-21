import { z } from "zod";
import { normalizeEmail } from "../contacts/email";
import { actorSource, loadContacts } from "../contacts/model";
import { OperationError } from "../errors";
import { defineOperation, type OperationContext } from "../registry/operation";
import { requireService } from "../services";
import { stopWelcome } from "../welcome/start";
import { eraseContact } from "./erase";
import { buildContactExport, ContactExportSchema } from "./export";

// Data rights of one contact (R21). Export and erase use the plan's scopes
// (`contacts:export`, `contacts:delete`). Both are MCP "later" (plan: MCP
// classification). Both write an audit row (R8), without the address in it.

const ContactId = z.coerce.number().int().positive();

async function requireContact(ctx: OperationContext, id: number) {
  const [contact] = await loadContacts(ctx.db.db, ctx.principal.workspaceId, [id]);
  if (!contact) throw new OperationError("not_found", "The contact does not exist.");
  return contact;
}

export const contactsExport = defineOperation({
  id: "contacts.export",
  summary: "Export one contact's data",
  description:
    "Returns everything Envelopen holds about one contact as JSON: the contact with tags, " +
    "list memberships, and custom fields, the suppression status, the consent history, the " +
    "campaigns that included the contact, and the email and provider events. Use it to " +
    "answer a data access request. The audit log records the export.",
  method: "post",
  path: "/contacts/{id}/export",
  scope: "contacts:export",
  // `write`, so the audit log records each export of personal data (R8).
  risk: "write",
  mcp: { class: "later", reason: "Contact export is in the plan's MCP 'later' set." },
  contactContent: true,
  input: z.object({ id: ContactId }),
  output: ContactExportSchema,
  async handler(input, ctx) {
    const contact = await requireContact(ctx, input.id);
    return buildContactExport(
      ctx.db.db,
      ctx.principal.workspaceId,
      contact,
      requireService(ctx.services, "hashEmail"),
      ctx.now,
    );
  },
  auditTarget: (_input, output) => ({
    targetType: "contact",
    targetId: output.contact.id,
    metadata: { truncated: output.truncated },
  }),
});

export const contactsErase = defineOperation({
  id: "contacts.erase",
  summary: "Erase one contact's data",
  description:
    "Removes the contact's personal data: the contact, tags, list memberships, custom " +
    "fields, consent history, raw email and provider events, the contact link on campaign " +
    "recipients, and audit metadata about the contact. Campaign counts stay. A suppression " +
    "keyed on a hash of the address stays, so an import or an upsert of the address stays " +
    "suppressed. `confirm` must repeat the contact's email address. This cannot be undone.",
  method: "post",
  path: "/contacts/{id}/erase",
  scope: "contacts:delete",
  risk: "destructive",
  mcp: { class: "later", reason: "Erase is in the plan's MCP 'later' set." },
  input: z.object({
    id: ContactId,
    confirm: z
      .string()
      .max(320)
      .meta({ description: "The contact's email address, typed again to confirm." }),
  }),
  output: z
    .object({
      id: z.number().int(),
      erasedAt: z.number().int(),
      removed: z.object({
        events: z.number().int(),
        providerEvents: z.number().int(),
        recipients: z.number().int(),
        auditEntries: z.number().int(),
      }),
    })
    .meta({ id: "ContactEraseResult" }),
  async handler(input, ctx) {
    const { now, principal } = ctx;
    const contact = await requireContact(ctx, input.id);
    if (normalizeEmail(input.confirm) !== contact.email) {
      throw new OperationError(
        "invalid_input",
        "Type the contact's email address exactly to confirm the erase.",
      );
    }
    const emailHash = await requireService(ctx.services, "hashEmail")(contact.email);
    const removed = await eraseContact(
      ctx.db,
      principal.workspaceId,
      { id: contact.id, email: contact.email, emailHash },
      { now, source: `erased:${actorSource(principal)}` },
    );
    // The per-step check stops a run that this misses: the contact no longer exists.
    await stopWelcome(ctx.db, ctx.services.welcome, principal.workspaceId, [contact.id]);
    return { id: contact.id, erasedAt: now, removed };
  },
  // The audit row keeps the contact id and counts. Never the address.
  auditTarget: (_input, output) => ({
    targetType: "contact",
    targetId: output.id,
    metadata: { erased: true, ...output.removed },
  }),
});
