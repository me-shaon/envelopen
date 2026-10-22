import { SOCIAL_NETWORKS, type SocialNetwork } from "./blocks/types";
import { contrastRatio, DARK_TEXT, MIN_TEXT_CONTRAST, readableTextColor } from "./contrast";
import {
  BRAND_TAGS,
  type BrandTag,
  decodeEntities,
  escapeHtml,
  type MergeMode,
} from "./merge-tags";

// Brand tokens (U13, KTD10). A template carries reserved tokens such as
// `{{ brand.color_primary }}` in inline styles and literal values. The Worker never
// renders React, so the tokens are filled by string substitution:
// - drafts and previews: the live brand kit;
// - a confirmed campaign: the snapshot stored at confirm;
// - welcome emails: the live brand kit at each send.
//
// Every value is checked again here, because a snapshot or a restored row is input too:
// - colors must be `#rrggbb` (or `#rgb`), else the default color applies;
// - the font is an id from BRAND_FONTS, else the default stack applies;
// - social links must be https URLs, the logo URL http or https, else they are empty;
// - in HTML, every value is HTML-escaped, and `{` and `}` become character references,
//   so a value can never form a merge tag or leave its attribute.
//
// No CSS custom properties: Gmail and Outlook ignore them. A template without brand
// tokens is returned unchanged, so its bytes stay the same (R24).

/** Web-safe font stacks. No quotes, so a stack is safe in a style attribute and in CSS. */
export const BRAND_FONTS = {
  system: {
    label: "System sans-serif",
    stack: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif",
  },
  helvetica: { label: "Helvetica", stack: "Helvetica Neue, Helvetica, Arial, sans-serif" },
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  tahoma: { label: "Tahoma", stack: "Tahoma, Verdana, sans-serif" },
  trebuchet: { label: "Trebuchet MS", stack: "Trebuchet MS, Helvetica, Arial, sans-serif" },
  georgia: { label: "Georgia", stack: "Georgia, Times New Roman, Times, serif" },
  times: { label: "Times New Roman", stack: "Times New Roman, Times, serif" },
  palatino: { label: "Palatino", stack: "Palatino Linotype, Book Antiqua, Palatino, serif" },
  courier: { label: "Courier New", stack: "Courier New, Courier, monospace" },
} as const;
export type BrandFontId = keyof typeof BRAND_FONTS;
export const BRAND_FONT_IDS = Object.keys(BRAND_FONTS) as BrandFontId[];

export const BRAND_NAME_MAX = 100;
export const BRAND_FOOTER_MAX = 500;
export const BRAND_ADDRESS_MAX = 300;
export const BRAND_URL_MAX = 500;

/** The brand values that fill the tokens. A campaign stores them as its snapshot. */
export interface BrandSnapshot {
  name: string;
  /** The absolute URL of the logo, or null without a logo. */
  logoUrl: string | null;
  /** The R2 key of the logo. A stored snapshot keeps the logo object alive. */
  logoKey: string | null;
  colorPrimary: string;
  colorAccent: string;
  font: string;
  footer: string;
  address: string;
  social: Partial<Record<SocialNetwork, string>>;
}

export const DEFAULT_BRAND: Readonly<BrandSnapshot> = Object.freeze({
  name: "",
  logoUrl: null,
  logoKey: null,
  colorPrimary: "#4a3c77",
  colorAccent: "#ede9f8",
  font: "system",
  footer: "",
  address: "",
  social: {},
});

/** `#rrggbb` in lower case, or null when the value is not a hex color. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${[...text.slice(1)].map((char) => char + char).join("")}`;
  }
  return null;
}

export function isBrandFont(value: unknown): value is BrandFontId {
  return typeof value === "string" && Object.hasOwn(BRAND_FONTS, value);
}

/** The font stack of a font id. An unknown id gives the default stack. */
export function brandFontStack(id: unknown): string {
  return isBrandFont(id) ? BRAND_FONTS[id].stack : BRAND_FONTS.system.stack;
}

/**
 * The URL when it is absolute, uses one of the schemes, and has no credentials, spaces,
 * or control characters. Else null.
 */
export function brandUrl(value: unknown, schemes: readonly ("https:" | "http:")[]): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
  if (text === "" || text.length > BRAND_URL_MAX || /[\s\u0000-\u001f\u007f<>"'`]/.test(text)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!(schemes as readonly string[]).includes(url.protocol)) return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href;
}

/** A clean snapshot from stored JSON or an object. Unknown or bad values get defaults. */
export function parseBrandSnapshot(value: unknown): BrandSnapshot {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = null;
    }
  }
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (item: unknown, max: number) => (typeof item === "string" ? item.slice(0, max) : "");
  const social: Partial<Record<SocialNetwork, string>> = {};
  const links = (input.social && typeof input.social === "object" ? input.social : {}) as Record<
    string,
    unknown
  >;
  for (const network of SOCIAL_NETWORKS) {
    const url = brandUrl(links[network], ["https:"]);
    if (url) social[network] = url;
  }
  return {
    name: text(input.name, BRAND_NAME_MAX),
    logoUrl: brandUrl(input.logoUrl, ["https:", "http:"]),
    logoKey: typeof input.logoKey === "string" && input.logoKey ? input.logoKey : null,
    colorPrimary: normalizeHexColor(input.colorPrimary) ?? DEFAULT_BRAND.colorPrimary,
    colorAccent: normalizeHexColor(input.colorAccent) ?? DEFAULT_BRAND.colorAccent,
    font: isBrandFont(input.font) ? input.font : DEFAULT_BRAND.font,
    footer: text(input.footer, BRAND_FOOTER_MAX),
    address: text(input.address, BRAND_ADDRESS_MAX),
    social,
  };
}

/** The value of each brand token, before escaping. */
export function brandTokenValues(brand: BrandSnapshot): Record<BrandTag, string> {
  const clean = parseBrandSnapshot(brand);
  const values: Record<string, string> = {
    "brand.name": clean.name,
    "brand.logo_url": clean.logoUrl ?? "",
    "brand.color_primary": clean.colorPrimary,
    "brand.color_accent": clean.colorAccent,
    // Text on a brand color (U15): white or a dark color, whichever reaches 4.5:1.
    "brand.color_on_primary": readableTextColor(clean.colorPrimary),
    "brand.color_on_accent": readableTextColor(clean.colorAccent),
    // The primary color as text on white: itself when it reaches 4.5:1, else dark text.
    "brand.color_primary_text":
      contrastRatio(clean.colorPrimary, "#ffffff") >= MIN_TEXT_CONTRAST
        ? clean.colorPrimary
        : DARK_TEXT,
    "brand.font": brandFontStack(clean.font),
    "brand.footer": clean.footer,
    "brand.address": clean.address,
  };
  for (const network of SOCIAL_NETWORKS) {
    values[`brand.social.${network}`] = clean.social[network] ?? "";
  }
  return values as Record<BrandTag, string>;
}

const TOKEN_NAMES = BRAND_TAGS.map((tag) => tag.replaceAll(".", "\\.")).join("|");
// The same fallback forms as merge tags (merge-tags.ts): `{{ brand.name | default: "x" }}`.
const FALLBACK =
  "(?:\\|\\s*default:\\s*(?:\"([^\"]*)\"|&quot;((?:(?!&quot;)[^<>])*)&quot;|'([^']*)'|&#x27;((?:(?!&#x27;)[^<>])*)&#x27;)\\s*)?";
const TOKEN = new RegExp(`\\{\\{\\s*(${TOKEN_NAMES})\\s*${FALLBACK}\\}\\}`, "g");
// The sanitizer writes every attribute in double quotes and escapes `<` and `>` in it,
// so `[^<>]*` cannot run past the end of the tag.
const LOGO_IMAGE = /<img\b[^<>]*\ssrc="\{\{\s*brand\.logo_url\s*\}\}"[^<>]*>/gi;
const SOCIAL_LINK = /<a\b[^<>]*\shref="\{\{\s*brand\.social\.([a-z]+)\s*\}\}"[^<>]*>[^<]*<\/a>/gi;
// The text part writes a link as `label url` (or `label [url]`). Without a URL, the
// label goes too.
const TEXT_URL =
  /(?:\b(?:Website|X|LinkedIn|Instagram|Facebook|YouTube|GitHub) )?\[?\{\{\s*(brand\.logo_url|brand\.social\.[a-z]+)\s*\}\}\]?/g;

/** Whether the text holds a brand token. */
export function hasBrandTokens(source: string): boolean {
  TOKEN.lastIndex = 0;
  const found = TOKEN.test(source);
  TOKEN.lastIndex = 0;
  return found;
}

function escapeHtmlValue(value: string): string {
  return escapeHtml(value).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

function escapeTextValue(value: string): string {
  // A value cannot open or close a merge tag in the subject or the text part.
  return value.replaceAll("{{", "{ {").replaceAll("}}", "} }");
}

/**
 * Fills the brand tokens of a template. In HTML, a logo image without a logo and a
 * social link without a URL are removed, so no broken image or empty link remains.
 * Returns the same string when the template has no brand token.
 */
export function applyBrand(source: string, brand: BrandSnapshot, mode: MergeMode): string {
  if (!source.includes("brand.") || !hasBrandTokens(source)) return source;
  const values = brandTokenValues(brand);
  let out = source;
  if (mode === "html") {
    if (!values["brand.logo_url"]) out = out.replace(LOGO_IMAGE, "");
    out = out.replace(SOCIAL_LINK, (whole, network: string) =>
      values[`brand.social.${network}` as BrandTag] ? whole : "",
    );
  } else {
    out = out.replace(TEXT_URL, (whole, name: string) => (values[name as BrandTag] ? whole : ""));
  }
  const escapeValue = mode === "html" ? escapeHtmlValue : escapeTextValue;
  return out.replace(TOKEN, (_whole, name: string, ...fallbacks: unknown[]) => {
    const value = values[name as BrandTag] ?? "";
    if (value) return escapeValue(value);
    const raw = fallbacks.slice(0, 4).find((item) => typeof item === "string") as
      | string
      | undefined;
    if (raw === undefined) return "";
    return mode === "html" ? escapeValue(decodeEntities(raw)) : escapeTextValue(raw);
  });
}

/** The brand values that the editor and the preview show for a token, unescaped. */
export function brandTokenValue(brand: BrandSnapshot, tag: BrandTag): string {
  return brandTokenValues(brand)[tag];
}

/** The token text of a brand tag, for example `{{ brand.color_primary }}`. */
export function brandToken(tag: BrandTag): string {
  return `{{ ${tag} }}`;
}

/** The brand tag of a token text, or null. */
export function brandTagOf(value: unknown): BrandTag | null {
  if (typeof value !== "string") return null;
  const match = /^\{\{\s*(brand\.[a-z_.]+)\s*\}\}$/.exec(value.trim());
  const name = match?.[1];
  return name && (BRAND_TAGS as readonly string[]).includes(name) ? (name as BrandTag) : null;
}
