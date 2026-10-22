import type { DbConnection } from "@envelopen/db";
import {
  applyBrand,
  type BrandSnapshot,
  DEFAULT_BRAND,
  missingMergeTags,
  previewValues,
  renderMergeTags,
} from "@envelopen/email-render";
import { fieldTexts } from "../contacts/fields";
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
 * The tracking domain of a sending domain, when its check passes. Until then, the
 * domain may not reach this Worker, so links on it (unsubscribe too) would break.
 */
export function verifiedTrackingDomain(
  row: { tracking_domain: string | null; tracking_status: string } | undefined,
): string | null {
  return row?.tracking_domain && row.tracking_status === "pass" ? row.tracking_domain : null;
}

/**
 * The origin of the unsubscribe and tracking links: the verified tracking domain
 * (`verifiedTrackingDomain`), or else the app's host. RFC 8058 needs an https
 * List-Unsubscribe URL, so the scheme is https even for a local app origin.
 */
export function testLinkOrigin(appOrigin: string | undefined, trackingDomain?: string | null) {
  if (trackingDomain) return `https://${trackingDomain}`;
  return `https://${appOrigin ? new URL(appOrigin).host : "example.com"}`;
}

export interface MergeField {
  key: string;
  label: string;
  kind: "standard" | "custom" | "reserved" | "brand";
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

/** Brand tokens that fit in text (U13). The editor offers them in the merge tag menu. */
const BRAND_FIELDS: MergeField[] = [
  { key: "brand.name", label: "Brand name", kind: "brand", sample: null },
  { key: "brand.footer", label: "Brand footer text", kind: "brand", sample: null },
  { key: "brand.address", label: "Postal address", kind: "brand", sample: null },
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
    ...BRAND_FIELDS,
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
    // Choice fields print their option labels (R13).
    ...(await fieldTexts(db.db, workspaceId, contact.fields)),
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

/**
 * Personalizes a stored template for a preview or a test send. The brand tokens are
 * filled first (U13): with the live brand for a draft, or a campaign's snapshot.
 */
export function personalizePreview(
  template: PreviewInput,
  fields: Readonly<Record<string, string | null>>,
  origin: string,
  brand: BrandSnapshot = DEFAULT_BRAND,
): Preview {
  const values = previewValues(fields, origin);
  const html = applyBrand(template.html ?? "", brand, "html");
  const subject = applyBrand(template.subject ?? "", brand, "text");
  return {
    subject: renderMergeTags(subject, values, "text"),
    preheader: renderMergeTags(applyBrand(template.preheader ?? "", brand, "text"), values, "text"),
    html: renderMergeTags(html, values, "html"),
    text: renderMergeTags(applyBrand(template.text ?? "", brand, "text"), values, "text"),
    missing: missingMergeTags(`${subject} ${html}`, values),
  };
}
