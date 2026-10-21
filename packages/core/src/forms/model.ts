import type { Database, Row } from "@envelopen/db";
import {
  embedSnippet,
  type FormPageField,
  recommendedFormHeight,
} from "@envelopen/email-render/form-page";
import type { Kysely } from "kysely";
import { z } from "zod";
import { type FieldDef, loadFieldDefs } from "../contacts/fields";
import { OperationError } from "../errors";

// Signup forms (U8, R10, R11, KTD6, KTD7). A form has lists, the custom fields that it
// asks, a consent text with a version, a success message, and the origins that may embed
// it in an iframe. The public pages live under /f/* in the Worker.

/** A confirmation link is valid for 72 hours (KTD7). */
export const SIGNUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
/** A signup can get a new link at most 3 times (KTD7). */
export const MAX_SIGNUP_RESENDS = 3;
/** The cron deletes a signup 7 days after it was created, once its link has expired. */
export const SIGNUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const FORM_NAME_MAX = 100;
export const CONSENT_TEXT_MAX = 2000;
export const SUCCESS_MESSAGE_MAX = 500;
export const MAX_FORM_LISTS = 20;
export const MAX_FORM_FIELDS = 10;
export const MAX_EMBED_ORIGINS = 10;
/** The longest text value that a form takes for a custom field. */
export const FORM_TEXT_MAX = 1000;

export const DEFAULT_CONSENT_TEXT =
  "I agree to get emails from this sender. I can unsubscribe at any time with the link in each email.";
export const DEFAULT_SUCCESS_MESSAGE = "Thank you. Your subscription is active.";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Checks one embed origin for `frame-ancestors` and returns it in its normal form, for
 * example `https://www.example.com`. Only a bare origin passes: the https scheme, a host,
 * and an optional port. A wildcard, a path, a query, a fragment, user info, a quote, a
 * semicolon, a comma, white space, CR, or LF is refused, so the value cannot change the
 * policy. Plain http is allowed only for localhost, for local tests.
 */
export function normalizeEmbedOrigin(raw: string): string {
  const value = raw.trim();
  const refuse = (reason: string): never => {
    throw new OperationError("invalid_input", `The origin "${value}" is not valid. ${reason}`, {
      field: "allowedOrigins",
    });
  };
  if (value.length === 0 || value.length > 200)
    refuse("Enter an origin of 200 characters or fewer.");
  const control = [...value].some(
    (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
  );
  if (/[\s;,'"*\\<>]/.test(value) || control) {
    refuse("Remove wildcards, spaces, and the characters ; , ' \" < > \\.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("Use the form https://www.example.com.");
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) refuse("Use an https origin.");
  if (url.username || url.password) refuse("Remove the user name and password.");
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    refuse("Remove the query and the fragment.");
  }
  const bare = value.endsWith("/") ? value.slice(0, -1) : value;
  if (url.pathname !== "/" || bare.toLowerCase() !== url.origin.toLowerCase()) {
    refuse("Use only the scheme and the host, without a path.");
  }
  if (url.hostname.startsWith(".") || (!url.hostname.includes(".") && !local)) {
    refuse("Use a full host name.");
  }
  return url.origin;
}

/** Parses a JSON array of positive integers. Bad data gives an empty list. */
export function idList(json: string | null): number[] {
  try {
    const value: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

/** Parses a JSON array of strings. Bad data gives an empty list. */
export function textList(json: string | null): string[] {
  try {
    const value: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** A random public id of 20 lowercase hex characters (80 bits). */
export function newPublicId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const PUBLIC_ID_PATTERN = /^[0-9a-f]{20}$/;

/** The custom fields of a form, in the order of `fieldIds`. Deleted fields are left out. */
export async function formFieldDefs(
  db: Kysely<Database>,
  workspaceId: number,
  fieldIds: readonly number[],
): Promise<FieldDef[]> {
  if (fieldIds.length === 0) return [];
  const defs = [...(await loadFieldDefs(db, workspaceId)).values()];
  return fieldIds.flatMap((id) => defs.filter((def) => def.id === id));
}

export function pageFields(defs: readonly FieldDef[]): FormPageField[] {
  return defs.map((def) => ({
    key: def.key,
    label: def.label,
    type: def.type,
    options: def.options.map((option) => ({ id: option.id, label: option.label })),
  }));
}

export const FormSchema = z
  .object({
    id: z.number().int(),
    publicId: z.string().meta({ description: "The random id in the public URL /f/{publicId}." }),
    name: z.string(),
    listIds: z.array(z.number().int()),
    fieldIds: z.array(z.number().int()).meta({
      description: "The custom fields that the form asks, in order.",
    }),
    consentText: z.string(),
    consentVersion: z.number().int().meta({
      description: "Goes up by one each time the consent text changes.",
    }),
    successMessage: z.string(),
    allowedOrigins: z.array(z.string()).meta({
      description: "Bare https origins that may embed the form in an iframe.",
    }),
    fromName: z.string().nullable(),
    fromEmail: z.string().nullable().meta({
      description:
        "The From address of the confirmation email. Null uses noreply@ the first verified sending domain.",
    }),
    enabled: z.boolean(),
    hostedUrl: z.string().nullable().meta({
      description: "The hosted page. Null when the app origin is not known.",
    }),
    embedSnippet: z.string().nullable().meta({ description: "The iframe snippet for a website." }),
    recommendedHeight: z.number().int().meta({
      description: "The iframe height in pixels that fits every state of the form.",
    }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "SignupForm" });

export type Form = z.input<typeof FormSchema>;

export function toForm(row: Row<"forms">, defs: readonly FieldDef[], appOrigin?: string): Form {
  const height = recommendedFormHeight(pageFields(defs));
  const hostedUrl = appOrigin ? `${appOrigin}/f/${row.public_id}` : null;
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    listIds: idList(row.list_ids),
    fieldIds: idList(row.field_ids),
    consentText: row.consent_text,
    consentVersion: row.consent_version,
    successMessage: row.success_message,
    allowedOrigins: textList(row.allowed_origins),
    fromName: row.from_name,
    fromEmail: row.from_email,
    enabled: row.enabled === 1,
    hostedUrl,
    embedSnippet: hostedUrl ? embedSnippet(hostedUrl, row.name, height) : null,
    recommendedHeight: height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
