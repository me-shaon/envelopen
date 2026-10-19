import type { Align, SocialLink } from "@envelopen/email-render/blocks/types";
import { DEFAULT_BUTTON, DEFAULT_FOOTER_TEXT } from "@envelopen/email-render/blocks/types";
import { type Extensions, mergeAttributes, Node } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

// Tiptap v3 nodes for the origin block set (R26). Text blocks (heading, paragraph) are
// the StarterKit nodes. Every other block is an atom: the canvas shows a likeness of
// the email, and the settings panel edits its attributes. The JSON that these nodes
// produce is the EmailDocument that packages/email-render renders.

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

function ButtonView({ attrs }: { attrs: Record<string, unknown> }) {
  return (
    <div className={cn("py-2", alignClass(attrs.align))}>
      <span
        className="inline-block rounded-[9px] px-5 py-3 text-[15px] font-semibold"
        style={{
          background: str(attrs.background) || DEFAULT_BUTTON.background,
          color: str(attrs.color) || DEFAULT_BUTTON.color,
        }}
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

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column column",
  isolating: true,
  draggable: true,
  parseHTML() {
    return [{ tag: 'div[data-block="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block": "columns",
        class: "my-1 grid grid-cols-2 gap-3 rounded-lg border border-dashed border-border p-2",
      }),
      0,
    ];
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

export function editorExtensions(): Extensions {
  return [
    StarterKit.configure({
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
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    Placeholder.configure({ placeholder: "Write something, or add a block from the panel." }),
    ImageBlock,
    ButtonBlock,
    DividerBlock,
    SpacerBlock,
    SocialBlock,
    FooterBlock,
    HtmlBlock,
    Columns,
    Column,
    MergeTag,
  ];
}
