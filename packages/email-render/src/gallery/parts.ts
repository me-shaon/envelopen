import {
  type Align,
  BRAND_COLOR_TOKENS,
  type BrandFooterNode,
  type BrandHeaderNode,
  type ButtonNode,
  type ColumnChild,
  type ColumnsNode,
  type DividerNode,
  type HeadingNode,
  type InlineNode,
  type MergeTagNode,
  PANEL_TINT,
  type PanelNode,
  type ParagraphNode,
  type SocialNetwork,
  type SpacerNode,
  type TextNode,
} from "../blocks/types";

// Small builders for the gallery documents (U15). The documents use only the blocks of
// the builder (no raw HTML), so each one opens and edits in the editor like any other.

/** Plain text, or text with marks. */
export function t(text: string, ...marks: ("bold" | "italic")[]): TextNode {
  return marks.length > 0
    ? { type: "text", text, marks: marks.map((type) => ({ type })) }
    : { type: "text", text };
}

/** A text link. */
export function a(text: string, href: string): TextNode {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

/** The contact's first name, with a fallback. */
export function firstName(fallback = "there"): MergeTagNode {
  return { type: "mergeTag", attrs: { field: "first_name", fallback } };
}

function inline(content: (string | InlineNode)[]): InlineNode[] {
  return content.map((item) => (typeof item === "string" ? t(item) : item));
}

export function h(level: 1 | 2 | 3, ...content: (string | InlineNode)[]): HeadingNode {
  return { type: "heading", attrs: { level }, content: inline(content) };
}

export function p(...content: (string | InlineNode)[]): ParagraphNode {
  return { type: "paragraph", content: inline(content) };
}

export function button(
  label: string,
  href: string,
  options: { align?: Align; tone?: "primary" | "accent" } = {},
): ButtonNode {
  const accent = options.tone === "accent";
  return {
    type: "button",
    attrs: {
      label,
      href,
      align: options.align ?? "left",
      background: accent ? BRAND_COLOR_TOKENS.accent : BRAND_COLOR_TOKENS.primary,
      color: accent ? BRAND_COLOR_TOKENS.onAccent : BRAND_COLOR_TOKENS.onPrimary,
    },
  };
}

export function divider(): DividerNode {
  return { type: "divider" };
}

export function spacer(height: number): SpacerNode {
  return { type: "spacer", attrs: { height } };
}

export function columns(...items: ColumnChild[][]): ColumnsNode {
  return { type: "columns", content: items.map((content) => ({ type: "column", content })) };
}

export function brandHeader(
  align: Align = "center",
  options: { showName?: boolean; logoWidth?: number } = {},
): BrandHeaderNode {
  return {
    type: "brandHeader",
    attrs: { align, showName: options.showName ?? true, logoWidth: options.logoWidth ?? 140 },
  };
}

const FOOTER_NETWORKS: SocialNetwork[] = ["website", "x", "linkedin", "instagram"];

export function brandFooter(align: Align = "center"): BrandFooterNode {
  return { type: "brandFooter", attrs: { align, networks: FOOTER_NETWORKS } };
}

export type PanelTone = "primary" | "accent" | "tint";

/**
 * A panel block: a box in a brand color (or a light tint) with text blocks and buttons.
 * The renderer gives its text the readable color for the background.
 */
export function panel(
  tone: PanelTone,
  content: (ColumnChild | ColumnsNode)[],
  options: { align?: Align; padding?: 20 | 28 | 40 } = {},
): PanelNode {
  const background =
    tone === "primary"
      ? BRAND_COLOR_TOKENS.primary
      : tone === "accent"
        ? BRAND_COLOR_TOKENS.accent
        : PANEL_TINT;
  return {
    type: "panel",
    attrs: { background, padding: options.padding ?? 28, align: options.align ?? "left" },
    content,
  };
}
