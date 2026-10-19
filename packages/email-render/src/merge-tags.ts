// Merge tags (R29): `{{ first_name }}` or `{{ first_name | default: "there" }}`.
//
// The Worker personalizes every recipient with string work only (KTD26). `compile`
// splits a template into literal parts and tags once per batch, and `fill` joins them
// for one recipient. In HTML, every value and fallback is HTML-escaped, so contact data
// cannot add markup. In plain text (the subject and the text part), values stay as they
// are.
//
// React escapes the quotes of a fallback in rendered HTML (`&quot;`), so both quote
// forms are accepted. Names that start with `@` are internal: personalization uses
// them for tracking links and the open pixel.

export type MergeMode = "html" | "text";

/** Tags that personalization fills from the recipient's token, not from contact data. */
export const RESERVED_TAGS = ["unsubscribe_url", "preferences_url"] as const;
export type ReservedTag = (typeof RESERVED_TAGS)[number];

/** The standard contact fields. Custom fields use their key, for example `course`. */
export const STANDARD_FIELDS = ["email", "first_name", "last_name"] as const;

export interface MergeTag {
  name: string;
  /** The fallback, decoded. Null when the tag has none. */
  fallback: string | null;
}

export interface CompiledTemplate {
  mode: MergeMode;
  /** Literal text. There is one more part than there are tags. */
  parts: string[];
  tags: MergeTag[];
}

const TAG_PATTERN =
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*|@[a-z]+(?::\d+)?)\s*(?:\|\s*default:\s*(?:"([^"]*)"|&quot;((?:(?!&quot;)[^<>])*)&quot;|'([^']*)'|&#x27;((?:(?!&#x27;)[^<>])*)&#x27;)\s*)?\}\}/g;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decodes the character references that rendered HTML uses. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return NAMED[ref.toLowerCase()] ?? match;
  });
}

/** Splits a template into parts and tags. Run it once per batch. */
export function compile(source: string, mode: MergeMode): CompiledTemplate {
  const parts: string[] = [];
  const tags: MergeTag[] = [];
  let last = 0;
  for (const match of source.matchAll(TAG_PATTERN)) {
    parts.push(source.slice(last, match.index));
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    tags.push({
      name: match[1] as string,
      fallback: raw === undefined ? null : mode === "html" ? decodeEntities(raw) : raw,
    });
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return { mode, parts, tags };
}

/** Values by tag name. Return undefined, null, or an empty string for "no value". */
export type MergeValues = (name: string) => string | null | undefined;

/** Joins the parts with the recipient's values. The value or fallback is escaped in HTML. */
export function fill(template: CompiledTemplate, values: MergeValues): string {
  const { parts, tags, mode } = template;
  let out = parts[0] as string;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i] as MergeTag;
    const value = values(tag.name);
    const text =
      value === undefined || value === null || value === "" ? (tag.fallback ?? "") : value;
    out += (mode === "html" ? escapeHtml(text) : text) + (parts[i + 1] as string);
  }
  return out;
}

/** Values from a plain record. */
export function recordValues(
  record: Readonly<Record<string, string | null | undefined>>,
): MergeValues {
  return (name) => (Object.hasOwn(record, name) ? record[name] : undefined);
}

/** Compiles and fills in one step, for previews and test sends. */
export function renderMergeTags(
  source: string,
  values: Readonly<Record<string, string | null | undefined>>,
  mode: MergeMode,
): string {
  return fill(compile(source, mode), recordValues(values));
}

/** The names of the user-facing tags in a template, in first-use order. */
export function mergeTagNames(source: string): string[] {
  const names = new Set<string>();
  for (const tag of compile(source, "html").tags) {
    if (!tag.name.startsWith("@")) names.add(tag.name);
  }
  return [...names];
}

/** Tags that would render empty for these values: no value and no fallback. */
export function missingMergeTags(
  source: string,
  values: Readonly<Record<string, string | null | undefined>>,
): string[] {
  const missing = new Set<string>();
  for (const tag of compile(source, "html").tags) {
    if (tag.name.startsWith("@") || tag.fallback) continue;
    if (!values[tag.name]) missing.add(tag.name);
  }
  return [...missing];
}

/** The tag text that the editor writes for a merge tag node. */
export function mergeTagText(field: string, fallback: string): string {
  const clean = fallback.replaceAll('"', "");
  return clean ? `{{ ${field} | default: "${clean}" }}` : `{{ ${field} }}`;
}
