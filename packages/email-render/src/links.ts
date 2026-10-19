import { decodeEntities } from "./merge-tags";

// Link references for click tracking (KTD26). Each `<a href>` that click tracking may
// rewrite gets an index, in document order. The campaign stores the URL list once
// (the `links` table), and each email links to `/t/c/<token>/<index>`, so the token is
// the only per-recipient part and one HMAC covers every link.
//
// These links stay as they are:
// - `mailto:`, `tel:`, and fragment links, which a redirect cannot carry.
// - The unsubscribe and preference placeholders, which personalization fills with the
//   recipient's own `/u/` URL. A redirect in front of them would count an unsubscribe
// as a click.
// - Links whose URL holds a merge tag, because the stored URL would not be the one the
//   recipient got. They are personalized and not tracked.
//
// The sanitizer writes every href in double quotes, so one pattern finds them all.

const ANCHOR_HREF = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;

/** Whether click tracking rewrites this href (as written in the HTML, escaped). */
export function isTrackableHref(href: string): boolean {
  const url = decodeEntities(href).trim();
  return /^https?:\/\//i.test(url) && !url.includes("{{");
}

/** The trackable URLs in document order, decoded. Index `i` is the link `/t/c/<token>/i`. */
export function extractLinks(html: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(ANCHOR_HREF)) {
    const href = match[2] as string;
    if (isTrackableHref(href)) links.push(decodeEntities(href).trim());
  }
  return links;
}

/**
 * Replaces each trackable href with `rewrite(index)`. The indexes match `extractLinks`.
 * The replacement is inserted as is, so it must be safe inside a double-quoted attribute.
 */
export function rewriteLinks(
  html: string,
  rewrite: (index: number, url: string) => string,
): string {
  let index = 0;
  return html.replace(ANCHOR_HREF, (whole, start: string, href: string, end: string) => {
    if (!isTrackableHref(href)) return whole;
    const replacement = rewrite(index, decodeEntities(href).trim());
    index++;
    return `${start}${replacement}${end}`;
  });
}
