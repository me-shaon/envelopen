import type { DbConnection } from "@envelopen/db";
import { missingMergeTags, previewValues, renderMergeTags } from "@envelopen/email-render";
import { loadContacts } from "../contacts/model";
import { OperationError } from "../errors";

// Preview data (R27, R30). A preview and a test send personalize the stored HTML the
// same way, with the values of a chosen contact or with sample values, and with the
// unsubscribe placeholders pointing at `/u/test`. So a test send matches the preview.

export const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
};

/**
 * The origin of the `/u/test` links in previews and test sends. RFC 8058 needs an
 * https List-Unsubscribe URL, so the scheme is https even for a local app origin.
 */
export function testLinkOrigin(appOrigin: string | undefined, trackingDomain?: string | null) {
  if (trackingDomain) return `https://${trackingDomain}`;
  return `https://${appOrigin ? new URL(appOrigin).host : "example.com"}`;
}

export interface MergeField {
  key: string;
  label: string;
  kind: "standard" | "custom" | "reserved";
  sample: string | null;
}

const STANDARD: MergeField[] = [
  { key: "first_name", label: "First name", kind: "standard", sample: "Ada" },
  { key: "last_name", label: "Last name", kind: "standard", sample: "Lovelace" },
  { key: "email", label: "Email", kind: "standard", sample: SAMPLE_VALUES.email ?? null },
];

const RESERVED: MergeField[] = [
  { key: "unsubscribe_url", label: "Unsubscribe link", kind: "reserved", sample: null },
  { key: "preferences_url", label: "Preferences link", kind: "reserved", sample: null },
];

/** The tags a template can use: standard fields, the workspace's custom fields, links. */
export async function mergeFields(db: DbConnection, workspaceId: number): Promise<MergeField[]> {
  const custom = await db.db
    .selectFrom("contact_fields")
    .select(["key", "label"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("label")
    .execute();
  return [
    ...STANDARD,
    ...custom.map((field) => ({ ...field, kind: "custom" as const, sample: null })),
    ...RESERVED,
  ];
}

/** Merge values of one contact, or the sample values without a contact. */
export async function contactValues(
  db: DbConnection,
  workspaceId: number,
  contactId: number | undefined,
): Promise<Record<string, string | null>> {
  if (contactId === undefined) return { ...SAMPLE_VALUES };
  const [contact] = await loadContacts(db.db, workspaceId, [contactId]);
  if (!contact) throw new OperationError("not_found", "The contact does not exist.");
  return {
    ...contact.fields,
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
  };
}

export interface PreviewInput {
  subject: string | null;
  preheader: string | null;
  html: string | null;
  text: string | null;
}

export interface Preview {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** Tags that render empty: no value and no fallback. */
  missing: string[];
}

/** Personalizes a stored template for a preview or a test send. */
export function personalizePreview(
  template: PreviewInput,
  fields: Readonly<Record<string, string | null>>,
  origin: string,
): Preview {
  const values = previewValues(fields, origin);
  const html = template.html ?? "";
  return {
    subject: renderMergeTags(template.subject ?? "", values, "text"),
    preheader: renderMergeTags(template.preheader ?? "", values, "text"),
    html: renderMergeTags(html, values, "html"),
    text: renderMergeTags(template.text ?? "", values, "text"),
    missing: missingMergeTags(`${template.subject ?? ""} ${html}`, values),
  };
}
