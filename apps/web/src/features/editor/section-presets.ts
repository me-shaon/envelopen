import {
  type BlockNode,
  BRAND_COLOR_TOKENS,
  type ButtonNode,
  type ColumnChild,
  type ColumnNode,
  type ColumnsNode,
  defaultBlock,
  type HeadingNode,
  MAX_COLUMNS,
  type ParagraphNode,
} from "@envelopen/email-render/blocks/types";

// Ready sections of the block library (U14, R21) and the column count of a section
// (R22). A section is the existing `columns` node with 1 to 3 `column` nodes, so the
// block format stays at EDITOR_VERSION 1 (KTD11). Presets use brand color tokens, so a
// new section follows the brand kit (U13).

export type SectionPresetId = "hero" | "textImage" | "features" | "callToAction" | "footer";

export interface SectionPreset {
  id: SectionPresetId;
  label: string;
  description: string;
  /** New blocks for the section. Each call returns new objects. */
  blocks: () => BlockNode[];
}

function heading(level: 1 | 2 | 3, text: string): HeadingNode {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function paragraph(text: string): ParagraphNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function brandButton(label: string, align: "left" | "center"): ButtonNode {
  return {
    type: "button",
    attrs: {
      label,
      href: "https://",
      align,
      background: BRAND_COLOR_TOKENS.primary,
      color: "#ffffff",
    },
  };
}

function column(...content: ColumnChild[]): ColumnNode {
  return { type: "column", content };
}

export const SECTION_PRESETS: readonly SectionPreset[] = [
  {
    id: "hero",
    label: "Hero",
    description: "A large image, a headline, a short text, and a button.",
    blocks: () => [
      { type: "image", attrs: { src: "", alt: "", width: 600, href: "", align: "center" } },
      heading(1, "A headline for your news"),
      paragraph("Tell readers in one or two sentences why this email is for them."),
      brandButton("Read more", "center"),
    ],
  },
  {
    id: "textImage",
    label: "Text and image",
    description: "Two columns: text with a button on the left, an image on the right.",
    blocks: () => [
      {
        type: "columns",
        content: [
          column(
            heading(3, "A short title"),
            paragraph("Describe the topic in a few sentences."),
            brandButton("Learn more", "left"),
          ),
          column({
            type: "image",
            attrs: { src: "", alt: "", width: 270, href: "", align: "center" },
          }),
        ],
      },
    ],
  },
  {
    id: "features",
    label: "Feature list",
    description: "A heading and three columns, each with a title and a text.",
    blocks: () => [
      heading(2, "What is new"),
      {
        type: "columns",
        content: [1, 2, 3].map((n) =>
          column(heading(3, `Feature ${n}`), paragraph("One sentence about the feature.")),
        ),
      },
    ],
  },
  {
    id: "callToAction",
    label: "Call to action",
    description: "A heading, one sentence, and a centered button.",
    blocks: () => [
      heading(2, "Ready to start?"),
      paragraph("Say what happens when the reader clicks the button."),
      brandButton("Get started", "center"),
    ],
  },
  {
    id: "footer",
    label: "Footer",
    description: "A divider, social links, and the footer with the unsubscribe link.",
    blocks: () => [defaultBlock("divider"), defaultBlock("social"), defaultBlock("footer")],
  },
];

/** An empty column for a section: one empty paragraph, which the schema requires. */
export function emptyColumn(): ColumnNode {
  return { type: "column", content: [{ type: "paragraph", content: [] }] };
}

/** Whether a node is a paragraph without text. A new empty column holds one. */
function isEmptyParagraph(node: ColumnChild): boolean {
  return node.type === "paragraph" && (node.content ?? []).length === 0;
}

/** The number of columns in a section. */
export function columnCount(section: ColumnsNode): number {
  return section.content?.length ?? 0;
}

/**
 * The section with `count` columns (1 to 3). More columns adds empty columns at the end.
 * Fewer columns moves the content of each removed column into the last column that
 * stays, so no content is lost. Empty paragraphs of a removed column are dropped.
 */
export function setColumnCount(section: ColumnsNode, count: number): ColumnsNode {
  const target = Math.min(Math.max(Math.trunc(count) || 1, 1), MAX_COLUMNS);
  const columns: ColumnNode[] = (section.content ?? []).map((item) => ({
    ...item,
    content: [...(item.content ?? [])],
  }));
  if (columns.length === 0) columns.push(emptyColumn());
  while (columns.length < target) columns.push(emptyColumn());
  if (columns.length > target) {
    const kept = columns.slice(0, target);
    const moved = columns
      .slice(target)
      .flatMap((item) => item.content ?? [])
      .filter((node) => !isEmptyParagraph(node));
    const last = kept[target - 1] as ColumnNode;
    const own = last.content ?? [];
    // A last column that holds only an empty paragraph takes the moved content alone.
    const base = moved.length > 0 && own.every(isEmptyParagraph) ? [] : own;
    const content = [...base, ...moved];
    kept[target - 1] = { ...last, content: content.length > 0 ? content : emptyColumn().content };
    return { ...section, content: kept };
  }
  return { ...section, content: columns };
}
