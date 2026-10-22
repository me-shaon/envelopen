import type {
  Align,
  BlockNode,
  SocialLink,
  SocialNetwork,
} from "@envelopen/email-render/blocks/types";
import {
  BRAND_COLOR_TOKENS,
  DEFAULT_BUTTON,
  DEFAULT_FOOTER_TEXT,
  MAX_COLUMNS,
  SOCIAL_NETWORKS,
} from "@envelopen/email-render/blocks/types";
import { brandFontStack } from "@envelopen/email-render/brand";
import { Extension, type Extensions, mergeAttributes, Node } from "@tiptap/core";
import { isNodeRangeSelection } from "@tiptap/extension-node-range";
import { Placeholder } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { ComponentType } from "react";
import { useBrand } from "@/features/brand/shared";
import { cn } from "@/lib/utils";
import { blockName, insertBlocks, LIBRARY_MIME, type MoveDirection, moveBlock } from "./doc";

// Tiptap v3 nodes for the origin block set (R26) and the brand blocks (U13). Text blocks
// (heading, paragraph) are the StarterKit nodes. Every other block is an atom: the canvas
// shows a likeness of the email, and the settings panel edits its attributes. The JSON
// that these nodes produce is the EmailDocument that packages/email-render renders. The
// canvas shows brand tokens with the live brand (BrandContext).

/** Blocks that a column can hold. Columns do not nest. */
const COLUMN_CONTENT = "(paragraph|heading|image|button|divider|spacer|html)+";

/** A list attribute, kept as JSON in a data attribute when the editor copies HTML. */
function jsonAttribute<T>(key: string, fallback: T) {
  const name = `data-${key}`;
  return {
    default: fallback,
    parseHTML: (element: HTMLElement) => {
      try {
        return JSON.parse(element.getAttribute(name) ?? "") as T;
      } catch {
        return fallback;
      }
    },
    renderHTML: (attrs: Record<string, unknown>) => ({ [name]: JSON.stringify(attrs[key]) }),
  };
}

function blockFrame(View: ComponentType<{ attrs: Record<string, unknown> }>, label: string) {
  return function BlockView({ node, selected }: ReactNodeViewProps) {
    return (
      <NodeViewWrapper
        data-drag-handle=""
        data-block={node.type.name}
        aria-label={label}
        className={cn(
          "my-1 cursor-pointer rounded-lg outline-offset-2 transition-[outline-color]",
          selected
            ? "outline-2 outline-ring"
            : "outline-1 outline-transparent hover:outline-border",
        )}
      >
        <View attrs={node.attrs} />
      </NodeViewWrapper>
    );
  };
}

function atomBlock(
  name: string,
  label: string,
  attributes: Record<string, unknown>,
  View: ComponentType<{ attrs: Record<string, unknown> }>,
) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      return Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [
          key,
          Array.isArray(value) ? jsonAttribute(key, value) : { default: value },
        ]),
      );
    },
    parseHTML() {
      return [{ tag: `div[data-block="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes(HTMLAttributes, { "data-block": name })];
    },
    addNodeView() {
      return ReactNodeViewRenderer(blockFrame(View, label));
    },
  });
}

function alignClass(align: unknown) {
  return align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

function ImageView({ attrs }: { attrs: Record<string, unknown> }) {
  const src = str(attrs.src);
  return (
    <div className={alignClass(attrs.align)}>
      {src ? (
        <img
          src={src}
          alt={str(attrs.alt)}
          style={{ width: Number(attrs.width) || 600 }}
          className="inline-block max-w-full rounded-lg"
        />
      ) : (
        <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-input text-[13px] text-muted-foreground">
          Image: add the image URL in the settings
        </div>
      )}
    </div>
  );
}

/** A color setting as the canvas shows it: a brand token becomes the live brand color. */
export function useColor(value: unknown, fallback: string): string {
  const brand = useBrand();
  if (value === BRAND_COLOR_TOKENS.primary) return brand.colorPrimary;
  if (value === BRAND_COLOR_TOKENS.accent) return brand.colorAccent;
  return str(value) || fallback;
}

function ButtonView({ attrs }: { attrs: Record<string, unknown> }) {
  const background = useColor(attrs.background, DEFAULT_BUTTON.background);
  const color = useColor(attrs.color, DEFAULT_BUTTON.color);
  return (
    <div className={cn("py-2", alignClass(attrs.align))}>
      <span
        className="inline-block rounded-[9px] px-5 py-3 text-[15px] font-semibold"
        style={{ background, color }}
      >
        {str(attrs.label) || "Button"}
      </span>
    </div>
  );
}

function DividerView() {
  return <hr className="my-4 border-0 border-t border-border" />;
}

function SpacerView({ attrs }: { attrs: Record<string, unknown> }) {
  const height = Number(attrs.height) || 24;
  return (
    <div
      className="flex items-center justify-center rounded-md bg-[repeating-linear-gradient(45deg,transparent_0_6px,var(--hairline)_6px_7px)] text-[11px] text-muted-foreground"
      style={{ height }}
    >
      <span className="figure">{height} px</span>
    </div>
  );
}

const NETWORK_LABELS: Record<string, string> = {
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  github: "GitHub",
};

function SocialView({ attrs }: { attrs: Record<string, unknown> }) {
  const links = Array.isArray(attrs.links) ? (attrs.links as SocialLink[]) : [];
  return (
    <div className={cn("py-2 text-[14px] text-tone-lavender-foreground", alignClass(attrs.align))}>
      {links.length === 0
        ? "Social links: add them in the settings"
        : links.map((link) => NETWORK_LABELS[link.network] ?? "Link").join(" · ")}
    </div>
  );
}

function FooterView({ attrs }: { attrs: Record<string, unknown> }) {
  return (
    <div className="mt-4 border-t border-border pt-3 text-[13px] text-muted-foreground">
      <p className="m-0 mb-2 whitespace-pre-line">{str(attrs.text)}</p>
      <p className="m-0">
        <span className="underline">Unsubscribe</span> ·{" "}
        <span className="underline">Email preferences</span>
      </p>
    </div>
  );
}

function BrandHeaderView({ attrs }: { attrs: Record<string, unknown> }) {
  const brand = useBrand();
  const width = Math.min(Math.max(Number(attrs.logoWidth) || 160, 40), 600);
  return (
    <div className={cn("py-2", alignClass(attrs.align ?? "center"))}>
      {brand.logoUrl ? (
        <img
          src={brand.logoUrl}
          alt={brand.name}
          style={{ width }}
          className="inline-block max-w-full"
        />
      ) : (
        <span className="inline-flex h-12 items-center rounded-lg border border-dashed border-input px-3 text-[12.5px] text-muted-foreground">
          No logo in the brand kit
        </span>
      )}
      {attrs.showName === false ? null : (
        <p
          className="m-0 mt-2 text-[20px] leading-[1.3] font-semibold"
          style={{ color: brand.colorPrimary, fontFamily: brandFontStack(brand.font) }}
        >
          {brand.name || "Brand name"}
        </p>
      )}
    </div>
  );
}

function BrandFooterView({ attrs }: { attrs: Record<string, unknown> }) {
  const brand = useBrand();
  const chosen = SOCIAL_NETWORKS.filter(
    (network) => Array.isArray(attrs.networks) && attrs.networks.includes(network),
  );
  const shown = chosen.filter((network) => brand.social[network]);
  return (
    <div
      className={cn(
        "mt-4 border-t border-border pt-3 text-[13px] text-muted-foreground",
        alignClass(attrs.align ?? "center"),
      )}
    >
      {shown.length > 0 ? (
        <p className="m-0 mb-3 flex flex-wrap justify-[inherit] gap-x-3 text-[14px]">
          {shown.map((network) => (
            <span key={network} style={{ color: brand.colorPrimary }}>
              {NETWORK_LABELS[network]}
            </span>
          ))}
        </p>
      ) : null}
      <p className="m-0 mb-2 whitespace-pre-line">
        {brand.footer || "Footer text from the brand kit"}
      </p>
      <p className="m-0 mb-2 whitespace-pre-line">
        {brand.address || "Postal address from the brand kit"}
      </p>
      <p className="m-0">
        <span className="underline">Unsubscribe</span> ·{" "}
        <span className="underline">Email preferences</span>
      </p>
    </div>
  );
}

function HtmlView({ attrs }: { attrs: Record<string, unknown> }) {
  const html = str(attrs.html);
  return (
    <div className="rounded-lg border border-border bg-muted px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">Raw HTML</span>
      {/* Shown as text: raw HTML runs only in the sandboxed preview, never here. */}
      <pre className="m-0 mt-1 max-h-32 overflow-hidden font-mono text-xs whitespace-pre-wrap text-foreground">
        {html || "Add HTML in the settings"}
      </pre>
    </div>
  );
}

export const ImageBlock = atomBlock(
  "image",
  "Image block",
  { src: "", alt: "", width: 600, href: "", align: "center" satisfies Align },
  ImageView,
);
export const ButtonBlock = atomBlock(
  "button",
  "Button block",
  { label: "Read more", href: "https://", align: "left", ...DEFAULT_BUTTON },
  ButtonView,
);
export const DividerBlock = atomBlock("divider", "Divider block", {}, DividerView);
export const SpacerBlock = atomBlock("spacer", "Spacer block", { height: 24 }, SpacerView);
export const SocialBlock = atomBlock(
  "social",
  "Social links block",
  { links: [] as SocialLink[], align: "center" },
  SocialView,
);
export const FooterBlock = atomBlock(
  "footer",
  "Footer block",
  { text: DEFAULT_FOOTER_TEXT },
  FooterView,
);
export const HtmlBlock = atomBlock("html", "Raw HTML block", { html: "" }, HtmlView);
export const BrandHeaderBlock = atomBlock(
  "brandHeader",
  "Brand header block",
  { align: "center" satisfies Align, showName: true, logoWidth: 160 },
  BrandHeaderView,
);
export const BrandFooterBlock = atomBlock(
  "brandFooter",
  "Brand footer block",
  { align: "center" satisfies Align, networks: [] as SocialNetwork[] },
  BrandFooterView,
);

/**
 * The document node with the email's font setting (U13). `font: "brand"` renders the
 * email with the brand font token. Null keeps the default font.
 */
export const EmailDocumentNode = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
  addAttributes() {
    return { font: { default: null } };
  },
});

/**
 * The grid of a section on the canvas. The columns stack when the canvas is narrow, as
 * they do in the email on a phone (the mobile canvas width).
 */
const SECTION_GRID: Record<number, string> = {
  1: "@md:grid-cols-1",
  2: "@md:grid-cols-2",
  3: "@md:grid-cols-3",
};

function sectionClass(count: number): string {
  return cn(
    "my-1 grid grid-cols-1 gap-3 rounded-lg border border-dashed border-border p-2",
    SECTION_GRID[count],
  );
}

/**
 * A section: 1 to 3 columns (U14). v0.3 documents have two columns, and they load
 * unchanged, because the content rule only allows more (R24).
 */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: `column{1,${MAX_COLUMNS}}`,
  isolating: true,
  draggable: true,
  parseHTML() {
    return [{ tag: 'div[data-block="columns"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block": "columns",
        "data-count": node.childCount,
        class: sectionClass(node.childCount),
      }),
      0,
    ];
  },
  addNodeView() {
    // ProseMirror keeps the outer element when only the columns change, so the view sets
    // the column count on each update.
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-block", "columns");
      const show = (count: number) => {
        dom.setAttribute("data-count", String(count));
        dom.className = sectionClass(count);
      };
      show(node.childCount);
      return {
        dom,
        contentDOM: dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          show(next.childCount);
          return true;
        },
      };
    };
  },
});

export const Column = Node.create({
  name: "column",
  content: COLUMN_CONTENT,
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-block="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-block": "column", class: "min-w-0 px-1" }),
      0,
    ];
  },
});

/** An inline merge tag (R29). It renders as `{{ field | default: "fallback" }}`. */
export const MergeTag = Node.create({
  name: "mergeTag",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { field: { default: "first_name" }, fallback: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-merge-tag]",
        getAttrs: (element) => ({
          field: element.getAttribute("data-merge-tag"),
          fallback: element.getAttribute("data-fallback") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const { field, fallback } = node.attrs as { field: string; fallback: string };
    return [
      "span",
      {
        "data-merge-tag": field,
        "data-fallback": fallback,
        class:
          "mx-px rounded-md bg-tone-lavender px-1.5 py-px font-mono text-[0.85em] text-tone-lavender-foreground",
      },
      fallback ? `${field} · ${fallback}` : field,
    ];
  },
  renderText({ node }) {
    return `{{ ${node.attrs.field} }}`;
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockMove: {
      /** Moves the top-level block of the selection up or down by one place. */
      moveBlock: (direction: MoveDirection) => ReturnType;
    };
  }
}

export interface BuilderOptions {
  /** Called with a short message for the screen reader after a block moves or lands. */
  announce: (message: string) => void;
}

/**
 * Keyboard reorder (U14): Alt+Shift+Up and Alt+Shift+Down move the selected top-level
 * block. After a drag with the handle, the moved block stays selected as a node, so the
 * settings panel shows it.
 */
const BlockMove = Extension.create<BuilderOptions>({
  name: "blockMove",
  addOptions() {
    return { announce: () => undefined };
  },
  addCommands() {
    return {
      moveBlock:
        (direction) =>
        ({ tr, dispatch }) => {
          const moved = moveBlock(tr, direction);
          if (!dispatch) return moved.status === "moved";
          if (moved.status === "edge") {
            this.options.announce(
              `${blockName(moved.type)} is already ${direction === "up" ? "first" : "last"}.`,
            );
          }
          if (moved.status !== "moved") return false;
          tr.scrollIntoView();
          this.options.announce(
            `${blockName(moved.type)} moved to position ${moved.index + 1} of ${moved.count}.`,
          );
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": () => this.editor.commands.moveBlock("up"),
      "Alt-Shift-ArrowDown": () => this.editor.commands.moveBlock("down"),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockMoveSelection"),
        // The drag handle selects the dropped blocks as a node range. A range of one
        // selectable node becomes a node selection.
        appendTransaction(_transactions, _old, state) {
          const { selection, doc } = state;
          if (!isNodeRangeSelection(selection)) return null;
          const node = doc.nodeAt(selection.from);
          if (!node || selection.from + node.nodeSize !== selection.to) return null;
          if (!NodeSelection.isSelectable(node)) return null;
          return state.tr.setSelection(NodeSelection.create(doc, selection.from));
        },
      }),
    ];
  },
});

/** Whether a drag carries blocks from the block library. */
export function isLibraryDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(LIBRARY_MIME);
}

/** The blocks of a library drag, or null when the data is not a block list. */
function libraryBlocks(event: DragEvent): BlockNode[] | null {
  try {
    const value = JSON.parse(event.dataTransfer?.getData(LIBRARY_MIME) ?? "") as unknown;
    return Array.isArray(value) && value.length > 0 ? (value as BlockNode[]) : null;
  } catch {
    return null;
  }
}

/**
 * Drops from the block library (KTD11). The library uses HTML5 drag. ProseMirror's drop
 * cursor shows where the blocks land, and this handler inserts them at the nearest
 * position that the schema allows: between blocks or in a column.
 */
const LibraryDrop = Extension.create<BuilderOptions>({
  name: "libraryDrop",
  addOptions() {
    return { announce: () => undefined };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("libraryDrop"),
        props: {
          handleDrop(view, event) {
            if (!isLibraryDrag(event)) return false;
            // The drag is ours from here on, so ProseMirror never moves the selection.
            const blocks = libraryBlocks(event);
            if (!blocks) return true;
            let slice: Slice;
            try {
              const nodes = blocks.map((block) => view.state.schema.nodeFromJSON(block));
              slice = new Slice(Fragment.fromArray(nodes), 0, 0);
            } catch {
              return true;
            }
            const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const doc = view.state.doc;
            const at = found
              ? (dropPoint(doc, found.pos, slice) ?? doc.content.size)
              : doc.content.size;
            insertBlocks(editor, blocks, at, { focus: true });
            options.announce(`${blockName(blocks[0]?.type ?? "")} added.`);
            return true;
          },
        },
      }),
    ];
  },
});

export function editorExtensions(options?: BuilderOptions): Extensions {
  const builder: BuilderOptions = options ?? { announce: () => undefined };
  return [
    StarterKit.configure({
      document: false,
      heading: { levels: [1, 2, 3] },
      blockquote: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      trailingNode: false,
      // The drop indicator for drags with the handle and from the library.
      dropcursor: { color: "var(--ring)", width: 2 },
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    Placeholder.configure({ placeholder: "Write something, or add a block from the panel." }),
    EmailDocumentNode,
    ImageBlock,
    ButtonBlock,
    DividerBlock,
    SpacerBlock,
    SocialBlock,
    FooterBlock,
    HtmlBlock,
    BrandHeaderBlock,
    BrandFooterBlock,
    Columns,
    Column,
    MergeTag,
    BlockMove.configure(builder),
    LibraryDrop.configure(builder),
  ];
}
