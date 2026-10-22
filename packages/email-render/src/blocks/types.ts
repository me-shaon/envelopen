// The block document of the editor (R26). The editor stores Tiptap JSON, and these
// types describe the subset that Envelopen uses: the origin block set (heading,
// paragraph, image, button, divider, spacer, two columns, social links, footer, and raw
// HTML), the brand header and footer (U13), and the inline content of text blocks. The renderer in ./render-blocks.tsx turns
// a document into React Email elements.
//
// This file has no dependencies, so the Worker, the browser, and the tests share it.

/** Bump when a block changes shape. Templates and saved blocks store the version. */
export const EDITOR_VERSION = 1;

export type Align = "left" | "center" | "right";

export type Mark =
  | { type: "bold" | "italic" | "underline" | "strike" }
  | { type: "link"; attrs: { href: string } };

export interface TextNode {
  type: "text";
  text: string;
  marks?: Mark[];
}

export interface HardBreakNode {
  type: "hardBreak";
}

/** A merge tag, rendered as `{{ field | default: "fallback" }}` (R29). */
export interface MergeTagNode {
  type: "mergeTag";
  attrs: { field: string; fallback: string };
}

export type InlineNode = TextNode | HardBreakNode | MergeTagNode;

export interface HeadingNode {
  type: "heading";
  attrs: { level: 1 | 2 | 3 };
  content?: InlineNode[];
}

export interface ParagraphNode {
  type: "paragraph";
  content?: InlineNode[];
}

export interface ImageNode {
  type: "image";
  attrs: { src: string; alt: string; width: number; href: string; align: Align };
}

export interface ButtonNode {
  type: "button";
  attrs: { label: string; href: string; align: Align; background: string; color: string };
}

export interface DividerNode {
  type: "divider";
}

export interface SpacerNode {
  type: "spacer";
  attrs: { height: number };
}

export interface ColumnNode {
  type: "column";
  content?: ColumnChild[];
}

export interface ColumnsNode {
  type: "columns";
  content?: ColumnNode[];
}

export const SOCIAL_NETWORKS = [
  "website",
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "youtube",
  "github",
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export interface SocialLink {
  network: SocialNetwork;
  url: string;
}

export interface SocialNode {
  type: "social";
  attrs: { links: SocialLink[]; align: Align };
}

/** The footer always carries the unsubscribe and preference links (R25). */
export interface FooterNode {
  type: "footer";
  attrs: { text: string };
}

/** Raw HTML. The Worker sanitizes it with the rest of the email at save time (KTD27). */
export interface HtmlNode {
  type: "html";
  attrs: { html: string };
}

/**
 * The brand header (U13): the brand logo and, when `showName` is on, the brand name.
 * Both come from brand tokens, so a change of the brand kit reaches every draft.
 */
export interface BrandHeaderNode {
  type: "brandHeader";
  attrs: { align: Align; showName: boolean; logoWidth: number };
}

/**
 * The brand footer (U13): the brand's social links (the chosen networks), footer text,
 * and postal address, then the unsubscribe and preference links (R25). A network
 * without a URL in the brand kit is left out when the email is filled.
 */
export interface BrandFooterNode {
  type: "brandFooter";
  attrs: { align: Align; networks: SocialNetwork[] };
}

/** Blocks that a column can hold. Columns do not nest. */
export type ColumnChild =
  | HeadingNode
  | ParagraphNode
  | ImageNode
  | ButtonNode
  | DividerNode
  | SpacerNode
  | HtmlNode;

export type BlockNode =
  | ColumnChild
  | ColumnsNode
  | SocialNode
  | FooterNode
  | BrandHeaderNode
  | BrandFooterNode;

/** Document settings. `font: "brand"` sets the email's font to the brand font token. */
export interface DocumentAttrs {
  font?: "brand" | null;
}

export interface EmailDocument {
  type: "doc";
  attrs?: DocumentAttrs;
  content: BlockNode[];
}

/** The block types of the origin block set, in the order the block panel shows them. */
export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "image",
  "button",
  "divider",
  "spacer",
  "columns",
  "social",
  "footer",
  "html",
  "brandHeader",
  "brandFooter",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const KNOWN_NODES = new Set<string>([...BLOCK_TYPES, "column", "text", "hardBreak", "mergeTag"]);

export const DEFAULT_BUTTON = { background: "#1a1917", color: "#ffffff" } as const;

/** The brand color tokens that a color setting can hold in place of a hex color (U13). */
export const BRAND_COLOR_TOKENS = {
  primary: "{{ brand.color_primary }}",
  accent: "{{ brand.color_accent }}",
} as const;

/** Whether a color setting holds a brand color token. */
export function isBrandColorToken(value: unknown): boolean {
  return value === BRAND_COLOR_TOKENS.primary || value === BRAND_COLOR_TOKENS.accent;
}

/** The token that a document with `font: "brand"` uses for its font. */
export const BRAND_FONT_TOKEN = "{{ brand.font }}";

export const DEFAULT_FOOTER_TEXT = "You receive this email because you subscribed to our updates.";

/** A new block of the type, with its default attributes. */
export function defaultBlock(type: BlockType): BlockNode {
  switch (type) {
    case "heading":
      return { type, attrs: { level: 2 }, content: [{ type: "text", text: "A clear heading" }] };
    case "paragraph":
      return { type, content: [{ type: "text", text: "Write something here." }] };
    case "image":
      return { type, attrs: { src: "", alt: "", width: 600, href: "", align: "center" } };
    case "button":
      return {
        type,
        attrs: { label: "Read more", href: "https://", align: "left", ...DEFAULT_BUTTON },
      };
    case "divider":
      return { type };
    case "spacer":
      return { type, attrs: { height: 24 } };
    case "columns":
      return {
        type,
        content: [
          { type: "column", content: [{ type: "paragraph", content: [] }] },
          { type: "column", content: [{ type: "paragraph", content: [] }] },
        ],
      };
    case "social":
      return { type, attrs: { links: [{ network: "website", url: "https://" }], align: "center" } };
    case "footer":
      return { type, attrs: { text: DEFAULT_FOOTER_TEXT } };
    case "html":
      return { type, attrs: { html: "" } };
    case "brandHeader":
      return { type, attrs: { align: "center", showName: true, logoWidth: 160 } };
    case "brandFooter":
      return { type, attrs: { align: "center", networks: [] } };
  }
}

/** A document for a new template. */
export function starterDocument(): EmailDocument {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [
          { type: "text", text: "Hello " },
          {
            type: "mergeTag",
            attrs: { field: "first_name", fallback: "there" },
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Write your message here." }],
      },
      defaultBlock("footer"),
    ],
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isNodeList(value: unknown, depth: number): boolean {
  return Array.isArray(value) && value.every((node) => isNode(node, depth));
}

function isNode(value: unknown, depth: number): boolean {
  if (depth > 12 || typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const node = value as { [key: string]: Json };
  if (typeof node.type !== "string" || !KNOWN_NODES.has(node.type)) return false;
  if (node.type === "text" && typeof node.text !== "string") return false;
  if (node.content !== undefined && !isNodeList(node.content, depth + 1)) return false;
  return true;
}

/**
 * A shallow structure check of stored editor JSON: a `doc` whose nodes all have known
 * types. The renderer tolerates missing attributes, so this is all the save path needs.
 */
export function isEmailDocument(value: unknown): value is EmailDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as { type?: unknown; content?: unknown };
  return doc.type === "doc" && isNodeList(doc.content ?? [], 0);
}

/** The same check for a saved block, which is a list of block nodes. */
export function isBlockList(value: unknown): value is BlockNode[] {
  return isNodeList(value, 0) && (value as unknown[]).length > 0;
}
