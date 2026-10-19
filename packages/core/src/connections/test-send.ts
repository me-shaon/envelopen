import type { DbConnection } from "@envelopen/db";
import {
  LIST_UNSUBSCRIBE,
  LIST_UNSUBSCRIBE_POST,
  ONE_CLICK_VALUE,
  type OutgoingMessage,
} from "@envelopen/providers";
import { z } from "zod";
import { normalizeEmail } from "../contacts/email";
import { OperationError } from "../errors";
import { defineOperation } from "../registry/operation";
import { TEST_SEND_ACTION } from "../registry/operations/onboarding";
import { getTemplateRow } from "../templates/operations";
import { contactValues, personalizePreview, testLinkOrigin } from "../templates/preview";
import { requireSendingConnection, sendThroughConnection } from "./send";

// Test sends (R30, R72). A test goes only to the owner's address and to the addresses
// that the owner adds in the workspace settings. So a key with campaigns:write, or an
// agent, cannot use a test send to mail anyone else. Only the owner's session edits
// the list.

const TestAddressSchema = z
  .object({
    id: z
      .number()
      .int()
      .nullable()
      .meta({ description: "Null for the owner's address, which cannot be removed." }),
    email: z.string(),
    owner: z.boolean(),
  })
  .meta({ id: "TestAddress" });

async function ownerEmails(db: DbConnection, workspaceId: number): Promise<string[]> {
  const rows = await db.db
    .selectFrom("workspace_members")
    .innerJoin("users", "users.id", "workspace_members.user_id")
    .select("users.email")
    .where("workspace_members.workspace_id", "=", workspaceId)
    .where("workspace_members.role", "=", "owner")
    .execute();
  return rows.map((row) => row.email.toLowerCase());
}

async function allowlist(db: DbConnection, workspaceId: number) {
  const [owners, added] = await Promise.all([
    ownerEmails(db, workspaceId),
    db.db
      .selectFrom("test_addresses")
      .select(["id", "email"])
      .where("workspace_id", "=", workspaceId)
      .orderBy("id", "asc")
      .execute(),
  ]);
  return [
    ...owners.map((email) => ({ id: null, email, owner: true })),
    ...added.filter((row) => !owners.includes(row.email)).map((row) => ({ ...row, owner: false })),
  ];
}

export const testAddressesList = defineOperation({
  id: "test_addresses.list",
  summary: "List test addresses",
  description:
    "Returns the addresses that test sends may go to: the owner's address and the added ones.",
  method: "get",
  path: "/test-addresses",
  scope: "campaigns:read",
  risk: "read",
  mcp: { class: "now", reason: "An agent needs to know where a test send may go." },
  input: z.object({}),
  output: z.object({ items: z.array(TestAddressSchema) }).meta({ id: "TestAddressList" }),
  async handler(_input, { principal, db }) {
    return { items: await allowlist(db, principal.workspaceId) };
  },
});

export const testAddressesAdd = defineOperation({
  id: "test_addresses.add",
  summary: "Add a test address",
  description: "Lets test sends go to one more address. Owner session only (R72).",
  method: "post",
  path: "/test-addresses",
  scope: "workspace:admin",
  risk: "write",
  mcp: {
    class: "never",
    reason: "The allowlist limits what agents can send. Only the owner edits it.",
  },
  successStatus: 201,
  input: z.object({ email: z.string().max(320) }),
  output: TestAddressSchema,
  async handler(input, { principal, db }) {
    const email = normalizeEmail(input.email);
    if (!email) throw new OperationError("invalid_input", "The email address is not valid.");
    const count = await db.db
      .selectFrom("test_addresses")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("workspace_id", "=", principal.workspaceId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= 20)
      throw new OperationError("conflict", "A workspace can have 20 test addresses.");
    const row = await db.db
      .insertInto("test_addresses")
      .values({ workspace_id: principal.workspaceId, email })
      .onConflict((conflict) => conflict.columns(["workspace_id", "email"]).doUpdateSet({ email }))
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, owner: false };
  },
  auditTarget: (_input, output) => ({
    targetType: "test_address",
    targetId: output.id ?? undefined,
  }),
});

export const testAddressesRemove = defineOperation({
  id: "test_addresses.remove",
  summary: "Remove a test address",
  method: "delete",
  path: "/test-addresses/{id}",
  scope: "workspace:admin",
  risk: "destructive",
  mcp: {
    class: "never",
    reason: "The allowlist limits what agents can send. Only the owner edits it.",
  },
  input: z.object({ id: z.coerce.number().int().positive() }),
  output: z.object({ id: z.number().int() }),
  async handler(input, { principal, db }) {
    const result = await db.db
      .deleteFrom("test_addresses")
      .where("workspace_id", "=", principal.workspaceId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0)
      throw new OperationError("not_found", "The test address does not exist.");
    return { id: input.id };
  },
  auditTarget: (_input, output) => ({ targetType: "test_address", targetId: output.id }),
});

const DEFAULT_HTML =
  "<p>This is a test email from Envelopen.</p><p>If you can read it, your provider connection works. " +
  "Open the original message to check the List-Unsubscribe and List-Unsubscribe-Post headers.</p>";

const TestSendResultSchema = z
  .object({
    results: z.array(
      z.object({
        to: z.string(),
        outcome: z.enum(["sent", "not_sent", "unknown"]),
        providerMessageId: z.string().nullable(),
        message: z.string().nullable(),
      }),
    ),
    provider: z.string(),
  })
  .meta({ id: "TestSendResult" });

export const campaignsSendTest = defineOperation({
  id: TEST_SEND_ACTION,
  summary: "Send a test email",
  description:
    "Sends a test email through the workspace's connection, with both unsubscribe " +
    "headers, to at most 5 addresses on the test list (R30, R72). The From address must " +
    "be on a sending domain of the workspace. With `templateId`, it sends the saved " +
    "template personalized with the same values as its preview.",
  method: "post",
  path: "/test-sends",
  scope: "campaigns:write",
  risk: "external_send",
  mcp: {
    class: "now",
    reason: "Test send is in the plan's MCP 'now' set, and the allowlist bounds it.",
  },
  input: z.object({
    to: z.array(z.string().max(320)).min(1).max(5),
    from: z.string().max(320),
    fromName: z.string().trim().max(100).optional(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .meta({ description: "Defaults to the template's subject, or to a fixed test subject." }),
    html: z.string().max(500_000).optional(),
    text: z.string().max(200_000).optional(),
    templateId: z.number().int().positive().optional().meta({
      description: "Send this template. Its subject, HTML, and text replace the defaults.",
    }),
    contactId: z.number().int().positive().optional().meta({
      description: "With templateId: personalize as this contact. Defaults to sample values.",
    }),
  }),
  output: TestSendResultSchema,
  async handler(input, ctx) {
    const { principal, db } = ctx;
    const workspaceId = principal.workspaceId;
    const recipients = [...new Set(input.to.map((email) => normalizeEmail(email)))];
    if (recipients.some((email) => email === null)) {
      throw new OperationError("invalid_input", "A recipient address is not valid.");
    }
    const allowed = new Set((await allowlist(db, workspaceId)).map((item) => item.email));
    const outside = (recipients as string[]).filter((email) => !allowed.has(email));
    if (outside.length > 0) {
      throw new OperationError(
        "forbidden",
        "Test sends go only to your address and to the test addresses in the workspace settings.",
        { notAllowed: outside },
      );
    }

    const from = normalizeEmail(input.from);
    const fromDomain = from?.split("@")[1];
    const domain = fromDomain
      ? await db.db
          .selectFrom("sending_domains")
          .select(["domain", "tracking_domain"])
          .where("workspace_id", "=", workspaceId)
          .where("domain", "=", fromDomain)
          .executeTakeFirst()
      : undefined;
    if (!from || !domain) {
      throw new OperationError(
        "invalid_input",
        "The From address must be on a sending domain of this workspace.",
      );
    }

    const row = await requireSendingConnection(db, workspaceId);
    // The test link goes to the unsubscribe page, which shows a generic message for it.
    // Without a tracking domain it is on the app's host, as in the template preview.
    const origin = testLinkOrigin(
      ctx.services.appOrigin ?? `https://${domain.domain}`,
      domain.tracking_domain,
    );
    const mailbox = input.fromName ? `${input.fromName.replaceAll(/["<>]/g, "")} <${from}>` : from;
    // A template test uses the preview's personalization, so it matches the preview.
    let content = { subject: input.subject, html: input.html, text: input.text };
    if (input.templateId !== undefined) {
      const template = await getTemplateRow(db.db, workspaceId, input.templateId);
      const values = await contactValues(db, workspaceId, input.contactId);
      const preview = personalizePreview(template, values, origin);
      content = {
        subject: input.subject ?? (preview.subject || undefined),
        html: input.html ?? preview.html,
        text: input.text ?? (preview.text || undefined),
      };
    }
    const subject = content.subject ?? "Envelopen test email";
    const messages: OutgoingMessage[] = (recipients as string[]).map((to, index) => ({
      recipientId: String(index),
      kind: "test",
      from: mailbox,
      to,
      subject: `[Test] ${subject}`,
      html: content.html ?? DEFAULT_HTML,
      ...(content.text ? { text: content.text } : {}),
      headers: {
        [LIST_UNSUBSCRIBE]: `<${origin}/u/test>`,
        [LIST_UNSUBSCRIBE_POST]: ONE_CLICK_VALUE,
      },
    }));
    const result = await sendThroughConnection(ctx, row, messages);
    const results = result.results.map((item, index) => ({
      to: (recipients as string[])[index] as string,
      outcome: item.outcome,
      providerMessageId: item.providerMessageId ?? null,
      message: item.message ?? null,
    }));
    // Nothing went out: no audit row, so the onboarding step stays open.
    if (!results.some((item) => item.outcome === "sent")) {
      throw new OperationError(
        "provider_error",
        result.failure?.message ??
          results[0]?.message ??
          "The provider did not send the test email.",
        { results },
      );
    }
    return { results, provider: row.provider };
  },
  auditTarget: (input, output) => ({
    targetType: "test_send",
    metadata: {
      recipients: input.to.length,
      ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      provider: output.provider,
      sent: output.results.filter((r) => r.outcome === "sent").length,
    },
  }),
});
