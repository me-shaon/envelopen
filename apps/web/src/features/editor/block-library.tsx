import { type BlockNode, type BlockType, defaultBlock } from "@envelopen/email-render/blocks/types";
import type { BrandSnapshot } from "@envelopen/email-render/brand";
import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  BookmarkIcon,
  BookmarkPlusIcon,
  CodeIcon,
  Columns2Icon,
  Columns3Icon,
  HeadingIcon,
  ImageIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  MegaphoneIcon,
  MinusIcon,
  MousePointerClickIcon,
  MoveVerticalIcon,
  PanelBottomDashedIcon,
  PanelBottomIcon,
  PanelTopIcon,
  PilcrowIcon,
  RectangleHorizontalIcon,
  SearchIcon,
  Share2Icon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type DragEvent, type ReactNode, useId, useState } from "react";
import { savedBlocksQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { cn } from "@/lib/utils";
import { LIBRARY_MIME } from "./doc";
import { SECTION_PRESETS, type SectionPresetId } from "./section-presets";

// The block library (U14, R21): block types, ready sections, and saved blocks. Each
// entry inserts on click (after the selected block) or by HTML5 drag onto the canvas,
// where the editor's drop handler inserts it at the drop position (KTD11). The entries
// are plain buttons, so the keyboard reaches and inserts every one of them. On narrow
// screens the library opens as a sheet and a tap inserts.

export interface LibraryEntry {
  id: string;
  /** The accessible name of the entry, such as "Add button". */
  action: string;
  label: string;
  description: string;
  icon: LucideIcon;
  blocks: () => BlockNode[];
}

const BLOCKS: { type: BlockType; label: string; description: string; icon: LucideIcon }[] = [
  { type: "paragraph", label: "Text", description: "A paragraph of text.", icon: PilcrowIcon },
  { type: "heading", label: "Heading", description: "A title for a part.", icon: HeadingIcon },
  { type: "image", label: "Image", description: "A picture from a URL.", icon: ImageIcon },
  {
    type: "button",
    label: "Button",
    description: "A link that looks like a button.",
    icon: MousePointerClickIcon,
  },
  { type: "divider", label: "Divider", description: "A thin line.", icon: MinusIcon },
  { type: "spacer", label: "Spacer", description: "Empty space.", icon: MoveVerticalIcon },
  {
    type: "panel",
    label: "Panel",
    description: "A colored box for a headline, text, and a button.",
    icon: RectangleHorizontalIcon,
  },
  {
    type: "columns",
    label: "Columns",
    description: "Two columns side by side.",
    icon: Columns2Icon,
  },
  {
    type: "social",
    label: "Social links",
    description: "Links to your profiles.",
    icon: Share2Icon,
  },
  {
    type: "footer",
    label: "Footer",
    description: "Footer text and the unsubscribe link.",
    icon: PanelBottomIcon,
  },
  {
    type: "brandHeader",
    label: "Brand header",
    description: "The logo and name from the brand kit.",
    icon: PanelTopIcon,
  },
  {
    type: "brandFooter",
    label: "Brand footer",
    description: "The footer from the brand kit.",
    icon: PanelBottomDashedIcon,
  },
  { type: "html", label: "Raw HTML", description: "Your own HTML code.", icon: CodeIcon },
];

const SECTION_ICONS: Record<SectionPresetId, LucideIcon> = {
  hero: LayoutTemplateIcon,
  textImage: Columns2Icon,
  features: Columns3Icon,
  callToAction: MegaphoneIcon,
  footer: PanelBottomIcon,
};

/** A new block. A brand footer starts with the networks that the brand kit has links for. */
export function newBlock(type: BlockType, brand: BrandSnapshot): BlockNode {
  const block = defaultBlock(type);
  if (block.type === "brandFooter") {
    block.attrs.networks = (Object.keys(brand.social) as (keyof typeof brand.social)[]).filter(
      (network) => brand.social[network],
    );
  }
  return block;
}

function blockEntries(brand: BrandSnapshot): LibraryEntry[] {
  return BLOCKS.map((block) => ({
    id: `block-${block.type}`,
    action: `Add ${block.label.toLowerCase()}`,
    label: block.label,
    description: block.description,
    icon: block.icon,
    blocks: () => [newBlock(block.type, brand)],
  }));
}

const SECTION_ENTRIES: LibraryEntry[] = SECTION_PRESETS.map((preset) => ({
  id: `section-${preset.id}`,
  action: `Add ${preset.label.toLowerCase()} section`,
  label: preset.label,
  description: preset.description,
  icon: SECTION_ICONS[preset.id],
  blocks: preset.blocks,
}));

/**
 * Starts an HTML5 drag of blocks. The JSON goes in the drag data for the drop handler.
 * The editor also gets the blocks as its drag slice, so ProseMirror's drop cursor shows
 * where they land.
 */
function startDrag(event: DragEvent, editor: Editor, entry: LibraryEntry) {
  const blocks = entry.blocks();
  event.dataTransfer.setData(LIBRARY_MIME, JSON.stringify(blocks));
  event.dataTransfer.setData("text/plain", entry.label);
  event.dataTransfer.effectAllowed = "copy";
  try {
    const nodes = blocks.map((block) => editor.schema.nodeFromJSON(block));
    editor.view.dragging = { slice: new Slice(Fragment.fromArray(nodes), 0, 0), move: false };
  } catch {
    // A saved block that the schema does not accept shows no drop cursor.
  }
}

function endDrag(editor: Editor) {
  const dragging = editor.view.dragging;
  // The drop handler runs first. A drag that ends elsewhere leaves nothing behind.
  window.setTimeout(() => {
    if (editor.view.dragging === dragging) editor.view.dragging = null;
  }, 50);
}

function EntryButton({
  entry,
  editor,
  draggable,
  onInsert,
}: {
  entry: LibraryEntry;
  editor: Editor;
  draggable: boolean;
  onInsert: (entry: LibraryEntry) => void;
}) {
  const descriptionId = useId();
  const Icon = entry.icon;
  return (
    <li>
      <button
        type="button"
        aria-label={entry.action}
        aria-describedby={descriptionId}
        draggable={draggable}
        data-library-entry={entry.id}
        onClick={() => onInsert(entry)}
        onDragStart={(event) => startDrag(event, editor, entry)}
        onDragEnd={() => endDrag(editor)}
        className={cn(
          "group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-press) hover:bg-accent max-md:min-h-11",
          draggable && "cursor-grab active:cursor-grabbing",
        )}
      >
        <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground group-hover:text-foreground">
          <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] leading-[1.35] font-medium">{entry.label}</span>
          <span id={descriptionId} className="text-xs leading-[1.4] text-muted-foreground">
            {entry.description}
          </span>
        </span>
      </button>
    </li>
  );
}

function EntryGroup({
  title,
  entries,
  editor,
  draggable,
  onInsert,
}: {
  title: string;
  entries: LibraryEntry[];
  editor: Editor;
  draggable: boolean;
  onInsert: (entry: LibraryEntry) => void;
}) {
  const titleId = useId();
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-1">
      <h3 id={titleId} className="m-0 px-2 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0" aria-label={title}>
        {entries.map((entry) => (
          <EntryButton
            key={entry.id}
            entry={entry}
            editor={editor}
            draggable={draggable}
            onInsert={onInsert}
          />
        ))}
      </ul>
    </section>
  );
}

/** The library: a search field, then the blocks, the sections, and the saved blocks. */
export function BlockLibrary({
  editor,
  brand,
  draggable = true,
  onInsert,
  onSaveBlock,
}: {
  editor: Editor;
  brand: BrandSnapshot;
  /** Drag needs a mouse. The sheet on narrow screens inserts on tap only. */
  draggable?: boolean;
  onInsert: (entry: LibraryEntry) => void;
  onSaveBlock: () => void;
}) {
  const { current } = useCurrentWorkspace();
  const saved = useQuery(savedBlocksQuery(current.id));
  const [query, setQuery] = useState("");
  const searchId = useId();
  const savedEntries: LibraryEntry[] = (saved.data?.items ?? []).map((block) => ({
    id: `saved-${block.id}`,
    action: `Insert ${block.name}`,
    label: block.name,
    description: "Saved block",
    icon: BookmarkIcon,
    blocks: () => JSON.parse(block.content) as BlockNode[],
  }));
  const words = query.trim().toLowerCase();
  const matches = (entry: LibraryEntry) =>
    !words || `${entry.label} ${entry.description}`.toLowerCase().includes(words);
  const blocks = blockEntries(brand).filter(matches);
  const sections = SECTION_ENTRIES.filter(matches);
  const savedShown = savedEntries.filter(matches);
  const empty = blocks.length + sections.length + savedShown.length === 0;
  const groupProps = { editor, draggable, onInsert };
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search blocks
        </label>
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search blocks"
          className="pl-8"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {empty ? (
        <p className="m-0 px-2 text-[12.5px] text-muted-foreground" role="status">
          No block matches “{query.trim()}”.
        </p>
      ) : null}
      <EntryGroup title="Blocks" entries={blocks} {...groupProps} />
      <EntryGroup title="Sections" entries={sections} {...groupProps} />
      <EntryGroup title="Saved blocks" entries={savedShown} {...groupProps} />
      {!words && savedEntries.length === 0 ? (
        <p className="m-0 px-2 text-[12.5px] text-muted-foreground">
          Select a block and save it to reuse it in other templates.
        </p>
      ) : null}
      <Button variant="outline" size="sm" className="self-start" onClick={onSaveBlock}>
        <BookmarkPlusIcon className="size-3.5" aria-hidden="true" />
        Save as block
      </Button>
    </div>
  );
}

/** The library as a sheet from the left edge, for narrow screens. A tap inserts. */
export function LibrarySheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="motion-overlay fixed inset-0 z-40 bg-[rgb(26_25_23/0.28)] dark:bg-black/60" />
        <DialogPrimitive.Content className="motion-sheet fixed inset-y-0 left-0 z-50 flex w-[min(320px,calc(100%-48px))] flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 text-foreground">
          <div className="flex flex-col gap-0.5">
            <DialogPrimitive.Title className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
              Add a block
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="m-0 text-[12.5px] text-muted-foreground">
              Tap a block to add it after the selected block.
            </DialogPrimitive.Description>
          </div>
          {children}
          <DialogPrimitive.Close asChild>
            <Button variant="outline" className="mt-auto">
              Close
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
