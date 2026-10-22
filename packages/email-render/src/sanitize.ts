import { decodeEntities } from "./merge-tags";

// The untrusted HTML boundary (KTD27, R69). Every template HTML is sanitized at save
// time with an allowlist: API HTML, Markdown output, and the HTML that the editor
// renders (its raw HTML block is user input too).
//
// Why HTMLRewriter: it is the Workers runtime's own streaming HTML rewriter (lol-html).
// It tokenizes like a browser (raw text elements, unquoted attributes, broken markup),
// costs nothing in the Worker bundle, and needs no DOM. DOMPurify needs a DOM, which
// Workers do not have (linkedom or jsdom would add hundreds of KB and parse less like a
// browser). sanitize-html works in Workers but pulls in htmlparser2 and PostCSS. The
// cost of this choice: the sanitizer runs only in workerd (Worker, tests, wrangler dev),
// not in the browser. The browser never needs it: previews render in a sandboxed iframe
// without scripts, and the Worker sanitizes before anything is stored.
//
// What survives: email layout tags (tables, text, images, links), inline styles, the
// head `<style>` for dark mode, and `<meta>` for the charset and color scheme. What goes:
// - Elements that run code or embed documents, with their content: script, iframe,
//   object, svg, math, form controls, and the like. Unknown elements keep their text.
// - Every attribute outside the allowlist, so all `on*` handlers.
// - URLs with schemes other than http, https, mailto, and tel (images: http, https,
//   cid), after decoding character references and removing control characters, so
//   `jav&#x61;script:` and `java\tscript:` are caught. A merge tag may not start a
//   URL, except the unsubscribe and preference placeholders and the brand logo and social
//   tokens, so contact data cannot set a link's scheme.
// - CSS with `expression(`, `javascript:`, `behavior`, `-moz-binding`, `@import`, a
//   non-http or unterminated `url(`, or a quoted `data:` string, after decoding CSS
//   escapes and removing comments. A `<style>` element with a `<` in its text.
// - A second attribute with the same name. Browsers keep the first one, and so does
//   the sanitizer, after it checked every value.
// - Comments, including Outlook conditional comments (their content is never checked).
//
// Every kept element is written again with double-quoted attributes, so links.ts can
// find each href with one pattern.

// biome-ignore format: one tag per line would make the list hard to scan.
const KEEP = new Set([
  "html", "head", "body", "title", "meta", "style",
  "a", "abbr", "address", "article", "b", "big", "blockquote", "br", "caption", "center",
  "cite", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "figcaption",
  "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
  "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "section",
  "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul", "wbr",
]);

/** Removed with everything inside them. */
// biome-ignore format: one tag per line would make the list hard to scan.
const DROP = new Set([
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
  "applet", "param", "svg", "math", "textarea", "select", "option", "optgroup", "input",
  "xmp", "plaintext", "noembed", "noframes", "base", "link", "audio", "video", "source",
  "track", "canvas", "portal", "dialog", "slot", "isindex", "keygen",
]);

// biome-ignore format: one tag per line would make the list hard to scan.
const GLOBAL_ATTRIBUTES = new Set([
  "style", "class", "id", "dir", "lang", "title", "role", "align", "valign", "width",
  "height", "bgcolor", "border", "cellpadding", "cellspacing", "color", "colspan",
  "rowspan", "face", "size", "nowrap", "hspace", "vspace", "start", "type", "scope",
]);

const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt"]),
  meta: new Set(["name", "content", "charset", "http-equiv"]),
  html: new Set(["xmlns", "xmlns:v", "xmlns:o"]),
  style: new Set(["media"]),
};

const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const IMAGE_SCHEMES = new Set(["http", "https", "cid"]);
const META_HTTP_EQUIV = new Set(["content-type", "x-ua-compatible"]);
// The brand URLs are checked when the brand is saved and again when they are filled
// (brand.ts): the logo URL is http or https, and each social link is https.
const URL_PLACEHOLDER =
  /^\{\{\s*(unsubscribe_url|preferences_url|brand\.logo_url|brand\.social\.(?:website|x|linkedin|instagram|facebook|youtube|github))\s*\}\}$/;

/** Returns the URL to keep, or null when it must go. Pass the decoded attribute value. */
export function safeUrl(value: string, schemes: ReadonlySet<string>): string | null {
  const trimmed = value.trim();
  if (URL_PLACEHOLDER.test(trimmed)) return trimmed;
  // Browsers ignore tabs and newlines inside a scheme and trim control characters.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them.
  const url = trimmed.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (url === "") return null;
  if (url.startsWith("#")) return trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme || !schemes.has(scheme)) return null;
  return trimmed;
}

/** Whether CSS text holds something that loads code or a non-http resource. */
export function unsafeCss(css: string): boolean {
  const plain = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/g, "$1")
    .toLowerCase();
  if (
    /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|<\/?style/.test(plain)
  ) {
    return true;
  }
  // A quoted data: URL loads without url(), for example in image-set('data:...').
  if (/['"]\s*data:/.test(plain)) return true;
  // Every url( must be a complete url(...) with an http or https URL. An unterminated
  // url( runs to the end of the declaration in a browser, so it is unsafe too.
  const opener = /url\s*\(/g;
  const full = /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/y;
  for (const open of plain.matchAll(opener)) {
    full.lastIndex = open.index;
    const match = full.exec(plain);
    if (!match || !/^https?:\/\//.test((match[2] as string).trim())) return true;
  }
  return false;
}

/** lol-html's setAttribute escapes only the double quote, so escape the rest first. */
function escapeForSetAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class ElementFilter implements HTMLRewriterElementContentHandlers {
  element(element: Element): void {
    const tag = element.tagName.toLowerCase();
    if (DROP.has(tag)) {
      element.remove();
      return;
    }
    if (!KEEP.has(tag)) {
      element.removeAndKeepContent();
      return;
    }
    const allowed = ELEMENT_ATTRIBUTES[tag];
    const kept: [string, string][] = [];
    const seen = new Set<string>();
    for (const [rawName = "", rawValue = ""] of [...element.attributes]) {
      const name = rawName.toLowerCase();
      element.removeAttribute(rawName);
      if (!(GLOBAL_ATTRIBUTES.has(name) || allowed?.has(name) || name.startsWith("aria-"))) {
        continue;
      }
      // `attributes` gives raw source text, so decode it once before the checks.
      let value: string | null = decodeEntities(rawValue);
      // Every copy of a repeated attribute is checked: a client may read any of them.
      if (name === "http-equiv" && !META_HTTP_EQUIV.has(value.trim().toLowerCase())) {
        // A refresh or another header that a mail client may act on: drop the element.
        element.remove();
        return;
      }
      // A browser keeps the first of two attributes with the same name, so only the
      // first is written back. A second `href` can never replace the checked one.
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === "href") value = safeUrl(value, LINK_SCHEMES);
      else if (name === "src") value = safeUrl(value, IMAGE_SCHEMES);
      else if (name === "style" && unsafeCss(value)) value = null;
      else if (name === "target") value = value.trim() === "_blank" ? "_blank" : null;
      if (value !== null) kept.push([name, value]);
    }
    // lol-html writes the attributes that a handler sets with double quotes.
    for (const [name, value] of kept) element.setAttribute(name, escapeForSetAttribute(value));
  }
}

/** Collects the text of a `<style>` element and drops it when the CSS is unsafe. */
class StyleFilter implements HTMLRewriterElementContentHandlers {
  private css = "";
  text(chunk: Text): void {
    this.css += chunk.text;
    chunk.remove();
    if (chunk.lastInTextNode) {
      // CSS needs no `<`. Without it, no markup can hide in the style text, and the
      // link pattern of links.ts never meets a tag start inside it.
      if (!this.css.includes("<") && !unsafeCss(this.css)) {
        chunk.replace(this.css, { html: true });
      }
      this.css = "";
    }
  }
}

/** Sanitizes a full HTML document or a fragment. Workers runtime only (HTMLRewriter). */
export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .on("*", new ElementFilter())
    .on("style", new StyleFilter());
  return rewriter.transform(new Response(html)).text();
}
