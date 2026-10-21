import {
  type FormPageView,
  renderFormPage,
  TURNSTILE_ORIGIN,
  usesTurnstile,
} from "@envelopen/email-render/form-page";
import { ENVELOPEN_VERSION } from "../version";

// Responses of the public form pages (KTD6). The renderer is shared with the admin
// preview (packages/email-render/src/form-page.ts). Each response has its own CSP:
//
// - Scripts and frames only from challenges.cloudflare.com, and only on a page that shows
//   the Turnstile widget. Every other page allows no script at all.
// - The one inline style block by nonce.
// - Forms post only to this origin.
// - `frame-ancestors`: the form and the pages that follow it in the same frame allow this
//   origin (the admin preview) and the form's checked embed origins. The confirmation
//   pages open from an email link and allow no frame.

export interface PageOptions {
  sourceUrl: string;
  /** The origins that may embed the page, or null for none. */
  ancestors: readonly string[] | null;
  embed?: boolean;
  status?: number;
}

export function formPageHeaders(
  nonce: string,
  turnstile: boolean,
  ancestors: readonly string[] | null,
): Record<string, string> {
  const script = turnstile ? TURNSTILE_ORIGIN : "'none'";
  const frameAncestors = ancestors === null ? "'none'" : ["'self'", ...ancestors].join(" ");
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      `script-src ${script}`,
      `frame-src ${script}`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
    "cache-control": "no-store",
    // A confirmation link holds its token in the path, so no other site gets it.
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  };
  if (ancestors === null) headers["x-frame-options"] = "DENY";
  return headers;
}

export function formPageResponse(view: FormPageView, options: PageOptions): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = renderFormPage(view, {
    nonce,
    sourceUrl: options.sourceUrl,
    version: ENVELOPEN_VERSION,
    embed: options.embed ?? false,
  });
  return new Response(html, {
    status: options.status ?? 200,
    headers: formPageHeaders(nonce, usesTurnstile(view), options.ancestors),
  });
}
