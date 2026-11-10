import { type PublicForm, type RawSubmission, textList } from "@envelopen/core";
import {
  type FormPageError,
  fieldInputId,
  TURNSTILE_ACTIONS,
} from "@envelopen/email-render/form-page";
import { z } from "zod";

// Headless signup forms: the owner's website renders its own form and posts JSON to
// /f/<publicId> from another origin. The steps after the request checks are the same as
// for the hosted form (IP limit, values, Turnstile, double opt-in). This module holds the
// parts that only the JSON flow has:
//
// - CORS. Only an `Origin` that exactly matches an entry of the form's `allowed_origins`
//   gets CORS headers. No credentials: the /f routes use no cookies.
// - The JSON contract of the metadata and the submission.
//
// The `Origin` check stops a browser page on a site that the owner did not list. It does
// not stop a script, which can send any `Origin`. Turnstile stops scripts: the token is
// single-use, and siteverify reports the host name of the page where the widget ran. The
// route requires that host name to be the host of the checked `Origin`.

export const JSON_TYPE = /^application\/json\s*(;|$)/i;
export const HEADLESS_ACTION = TURNSTILE_ACTIONS.headless;

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  vary: "Origin",
} as const;

/** The request `Origin` when it is one of the form's allowed origins, or null. */
export function allowedOrigin(request: Request, form: PublicForm | null): string | null {
  const origin = request.headers.get("origin");
  if (!form || origin === null || origin === "null") return null;
  return textList(form.row.allowed_origins).includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin ? { "access-control-allow-origin": origin } : {};
}

/** A JSON response. CORS headers only for an allowed origin. */
export function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...corsHeaders(origin) },
  });
}

/** The answer to a CORS preflight. Without an allowed origin, it has no CORS headers. */
export function preflightResponse(origin: string | null): Response {
  const headers: Record<string, string> = { vary: "Origin", "cache-control": "no-store" };
  if (origin) {
    Object.assign(headers, corsHeaders(origin), {
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
  }
  return new Response(null, { status: 204, headers });
}

/** The metadata that a website needs to render the form. */
export function metadataBody(form: PublicForm, siteKey: string, submitUrl: string) {
  return {
    ok: true,
    name: form.page.name,
    consentText: form.page.consentText,
    consentVersion: form.row.consent_version,
    fields: form.page.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options.map((option) => ({ id: option.id, label: option.label })),
      required: field.required === true,
    })),
    turnstile: { siteKey, action: HEADLESS_ACTION },
    submitUrl,
  };
}

const SubmissionSchema = z.object({
  email: z.string().max(1000),
  fields: z
    .record(z.string().max(100), z.union([z.string(), z.array(z.string()).max(100)]))
    .default({}),
  consentVersion: z.number().int(),
  turnstileToken: z.string().max(4096),
});

export interface HeadlessSubmission {
  raw: RawSubmission;
  consentVersion: number;
  turnstileToken: string;
}

export const BAD_BODY_MESSAGE =
  "Send a JSON object with email, fields, consentVersion, and turnstileToken.";

/** Parses the JSON body, or returns null when it does not match the contract. */
export function parseSubmission(bytes: Uint8Array): HeadlessSubmission | null {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const parsed = SubmissionSchema.safeParse(data);
  if (!parsed.success) return null;
  const { email, fields, consentVersion, turnstileToken } = parsed.data;
  return {
    raw: {
      email,
      fields: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          typeof value === "string" ? [value] : value,
        ]),
      ),
    },
    consentVersion,
    turnstileToken,
  };
}

/** The validation errors with field keys as targets, not the input ids of the hosted page. */
export function keyedErrors(errors: readonly FormPageError[]): FormPageError[] {
  const prefix = fieldInputId("");
  return errors.map((error) => ({
    target: error.target?.startsWith(prefix) ? error.target.slice(prefix.length) : error.target,
    message: error.message,
  }));
}
