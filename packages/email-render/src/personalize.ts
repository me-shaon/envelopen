import { applyBrand, type BrandSnapshot, DEFAULT_BRAND } from "./brand";
import { extractLinks, rewriteLinks } from "./links";
import { type CompiledTemplate, compile, fill } from "./merge-tags";
import type { RecipientRef, TokenSigner } from "./tokens";

// Send-time personalization (KTD26). The consumer calls `prepareMessage` once per batch
// and `personalize` once per recipient. Per recipient, the work is one HMAC for the
// token and string joins: no parsing and no rendering, so a batch of 50 fits the Free
// CPU budget (personalize-bench.test.ts and scripts/personalize-benchmark).
//
// Public URLs on the tracking domain (U10 serves them):
//   /t/o/<token>          open pixel
//   /t/c/<token>/<index>  click on link <index> of the campaign
//   /t/h/<token>          hidden honeypot link (bot clicks, KTD29)
//   /u/<token>            unsubscribe: GET shows the preference page, POST unsubscribes
//   /u/<token>/preferences  the preference page

export interface PrepareOptions {
  html: string;
  subject: string;
  text?: string | null;
  /** The tracking origin, for example `https://t.example.com`. No trailing slash. */
  trackingOrigin: string;
  trackOpens: boolean;
  trackClicks: boolean;
  /**
   * The brand that fills the `{{ brand.* }}` tokens (U13): a campaign's snapshot from
   * confirm, or the live brand kit for a welcome email. Defaults to DEFAULT_BRAND.
   */
  brand?: BrandSnapshot | null;
}

export interface PreparedMessage {
  html: CompiledTemplate;
  subject: CompiledTemplate;
  text: CompiledTemplate | null;
  /** The tracked URLs by index. The campaign stores them in the `links` table. */
  links: string[];
  trackingOrigin: string;
}

export interface Recipient extends RecipientRef {
  /** Merge values by tag name: email, first_name, last_name, and custom field keys. */
  fields: Readonly<Record<string, string | null | undefined>>;
}

export interface PersonalizedMessage {
  html: string;
  subject: string;
  text: string | null;
  /** The RFC 8058 headers (R25). */
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

const PIXEL =
  '<img src="{{ @open }}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />';
// Hidden from people and screen readers. Only a scanner that follows every link finds it.
const HONEYPOT =
  '<a href="{{ @honeypot }}" aria-hidden="true" tabindex="-1" style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden">&#8203;</a>';

function insertAfterBodyStart(html: string, snippet: string): string {
  const match = /<body\b[^>]*>/i.exec(html);
  if (!match) return snippet + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function insertBeforeBodyEnd(html: string, snippet: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}

/** Compiles the message once per batch: link references, the pixel, and the honeypot. */
export function prepareMessage(options: PrepareOptions): PreparedMessage {
  let html = options.html;
  let links: string[] = [];
  if (options.trackClicks) {
    links = extractLinks(html);
    html = rewriteLinks(html, (index) => `{{ @click:${index} }}`);
    html = insertAfterBodyStart(html, HONEYPOT);
  }
  if (options.trackOpens) html = insertBeforeBodyEnd(html, PIXEL);
  // After the link rewrite: a link to a brand URL holds a token there, so it is never
  // tracked, and the link indexes do not depend on the brand. A template without brand
  // tokens is not changed.
  const brand = options.brand ?? DEFAULT_BRAND;
  html = applyBrand(html, brand, "html");
  return {
    html: compile(html, "html"),
    subject: compile(applyBrand(options.subject, brand, "text"), "text"),
    text: options.text ? compile(applyBrand(options.text, brand, "text"), "text") : null,
    links,
    trackingOrigin: options.trackingOrigin.replace(/\/+$/, ""),
  };
}

/** Personalizes one recipient. Deterministic: the same input gives the same bytes. */
export async function personalize(
  prepared: PreparedMessage,
  recipient: Recipient,
  signer: TokenSigner,
): Promise<PersonalizedMessage> {
  const token = await signer.sign(recipient);
  const origin = prepared.trackingOrigin;
  const unsubscribe = `${origin}/u/${token}`;
  const fields = recipient.fields;
  const values = (name: string): string | null | undefined => {
    if (name.charCodeAt(0) === 64 /* @ */) {
      if (name.startsWith("@click:")) return `${origin}/t/c/${token}/${name.slice(7)}`;
      if (name === "@open") return `${origin}/t/o/${token}`;
      if (name === "@honeypot") return `${origin}/t/h/${token}`;
      return "";
    }
    if (name === "unsubscribe_url") return unsubscribe;
    if (name === "preferences_url") return `${unsubscribe}/preferences`;
    return Object.hasOwn(fields, name) ? fields[name] : undefined;
  };
  return {
    html: fill(prepared.html, values),
    subject: fill(prepared.subject, values),
    text: prepared.text ? fill(prepared.text, values) : null,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Personalization for previews and test sends: sample or contact values, and the
 * unsubscribe placeholders point at `<origin>/u/test`, which shows a generic page.
 * No tracking, so a test send matches the preview.
 */
export function previewValues(
  fields: Readonly<Record<string, string | null | undefined>>,
  origin: string,
): Record<string, string | null | undefined> {
  const base = origin.replace(/\/+$/, "");
  return { ...fields, unsubscribe_url: `${base}/u/test`, preferences_url: `${base}/u/test` };
}
