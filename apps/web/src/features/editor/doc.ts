import type { BlockNode, ColumnsNode, EmailDocument } from "@envelopen/email-render/blocks/types";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { setColumnCount } from "./section-presets";

// Helpers between the Tiptap editor and the email document.

/** The data type of a drag from the block library: a JSON list of block nodes. */
export const LIBRARY_MIME = "application/x-envelopen-blocks";

export type MoveDirection = "up" | "down";

const BLOCK_NAMES: Record<string, string> = {
  heading: "Heading",
  paragraph: "Text",
  image: "Image",
  button: "Button",
  divider: "Divider",
  spacer: "Spacer",
  columns: "Section",
  social: "Social links",
  footer: "Footer",
  html: "Raw HTML",
  brandHeader: "Brand header",
  brandFooter: "Brand footer",
  panel: "Panel",
};

/** The name of a block type for messages, such as "Button" or "Section". */
export function blockName(type: string): string {
  return BLOCK_NAMES[type] ?? "Block";
}

/**
 * The editor JSON is an EmailDocument: the extensions produce only its node types. The
 * document keeps `attrs` only with the brand font, so a template without it saves the
 * same JSON as before (R24).
 */
export function documentOf(editor: Editor): EmailDocument {
  return documentFromJSON(editor.getJSON());
}

/** The EmailDocument of editor JSON, as `documentOf` saves it. */
export function documentFromJSON(json: JSONContent): EmailDocument {
  const { attrs, ...doc } = json as EmailDocument;
  return attrs?.font === "brand" ? { ...doc, attrs: { font: "brand" } } : doc;
}

/** The font setting of the document: "brand" or null for the default font. */
export function documentFont(editor: Editor): "brand" | null {
  return editor.state.doc.attrs.font === "brand" ? "brand" : null;
}

/** Sets the font setting of the document. Undo restores it. */
export function setDocumentFont(editor: Editor, font: "brand" | null): void {
  editor
    .chain()
    .command(({ tr }) => {
      tr.setDocAttribute("font", font);
      return true;
    })
    .run();
}

/** The top-level block that holds the selection, with its position. */
export function currentBlock(
  editor: Editor,
): { node: JSONContent; pos: number; end: number } | null {
  const { selection, doc } = editor.state;
  if (doc.childCount === 0) return null;
  const index = Math.min(selection.$from.index(0), doc.childCount - 1);
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const node = doc.child(index);
  return { node: node.toJSON() as JSONContent, pos, end: pos + node.nodeSize };
}

/**
 * Inserts blocks and selects the last new block: an atom or a section as a node, a text
 * block with the cursor at its end. So the next insert lands after all of them. The
 * default place is after the current top-level block. A drop gives its own place. Focus
 * stays where it is, so a keyboard user stays in the block library. A drop focuses the
 * canvas.
 */
export function insertBlocks(
  editor: Editor,
  blocks: BlockNode[],
  place?: number,
  options: { focus?: boolean } = {},
): void {
  const at = place ?? currentBlock(editor)?.end ?? editor.state.doc.content.size;
  const chain = editor.chain();
  if (options.focus) chain.focus();
  chain
    .insertContentAt(at, blocks as JSONContent[])
    .command(({ tr }) => {
      const end = tr.mapping.map(at, 1);
      const node = tr.doc.resolve(end).nodeBefore;
      if (!node) return true;
      const start = end - node.nodeSize;
      if (node.isAtom || node.type.name === "columns" || node.type.name === "panel") {
        tr.setSelection(NodeSelection.create(tr.doc, start));
      } else if (node.isTextblock) {
        tr.setSelection(TextSelection.create(tr.doc, end - 1));
      }
      return true;
    })
    .scrollIntoView()
    .run();
}

/** The atom node (a block or a merge tag) that is selected. Its settings show in the panel. */
export function selectedAtom(
  editor: Editor,
): { type: string; attrs: Record<string, unknown> } | null {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection) || !selection.node.isAtom) return null;
  return { type: selection.node.type.name, attrs: selection.node.attrs };
}

/** The start position of the top-level block at `index`. */
function blockStart(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** The index of the top-level block that holds the selection. */
function selectedIndex(tr: { doc: PmNode; selection: Transaction["selection"] }): number {
  return Math.min(tr.selection.$from.index(0), tr.doc.childCount - 1);
}

/** Where the selected top-level block is: its index and the number of blocks. */
export function blockPlace(editor: Editor): { index: number; count: number } {
  const { state } = editor;
  return { index: selectedIndex(state), count: state.doc.childCount };
}

export type MoveResult =
  | { status: "moved"; type: string; index: number; count: number }
  | { status: "edge"; type: string }
  | { status: "none" };

/**
 * Moves the top-level block of the selection one place up or down in the transaction.
 * The selection moves with the block, so the same block stays selected.
 */
export function moveBlock(tr: Transaction, direction: MoveDirection): MoveResult {
  const { doc, selection } = tr;
  if (doc.childCount === 0) return { status: "none" };
  const index = selectedIndex(tr);
  const node = doc.child(index);
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= doc.childCount) return { status: "edge", type: node.type.name };
  const from = blockStart(doc, index);
  const to = from + node.nodeSize;
  // A selection that reaches outside the block becomes a selection of the block.
  const inside = selection.from >= from && selection.to <= to;
  const anchor = selection.anchor - from;
  const head = selection.head - from;
  const isNode = selection instanceof NodeSelection;
  tr.delete(from, to);
  const at =
    direction === "up"
      ? blockStart(tr.doc, target)
      : blockStart(tr.doc, index) + tr.doc.child(index).nodeSize;
  tr.insert(at, node);
  if (!inside) {
    tr.setSelection(NodeSelection.create(tr.doc, at));
  } else if (isNode) {
    tr.setSelection(NodeSelection.create(tr.doc, at + anchor));
  } else {
    tr.setSelection(TextSelection.create(tr.doc, at + anchor, at + head));
  }
  return { status: "moved", type: node.type.name, index: target, count: tr.doc.childCount };
}

/**
 * The top-level boundary nearest to a point on the screen: before the first block whose
 * middle is below the point, or the end of the document.
 */
export function boundaryAt(editor: Editor, y: number): number {
  const { doc } = editor.state;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return pos;
    }
    pos += doc.child(i).nodeSize;
  }
  return doc.content.size;
}

/** The section (a `columns` node) that holds the selection, with its position. */
export function selectedSection(editor: Editor): { pos: number; count: number } | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "columns") {
    return { pos: selection.from, count: selection.node.childCount };
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "columns") return { pos: $from.before(depth), count: node.childCount };
  }
  return null;
}

/**
 * Sets the number of columns of the section at `pos` (1 to 3). Content of a removed
 * column moves into the last column that stays. The section stays selected.
 */
export function setSectionColumns(editor: Editor, pos: number, count: number): void {
  const section = editor.state.doc.nodeAt(pos);
  if (section?.type.name !== "columns") return;
  const next = setColumnCount(section.toJSON() as ColumnsNode, count);
  editor
    .chain()
    .command(({ tr, state }) => {
      tr.replaceWith(pos, pos + section.nodeSize, state.schema.nodeFromJSON(next));
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      return true;
    })
    .run();
}

export interface SelectedPanel {
  pos: number;
  attrs: { background: unknown; padding: unknown; align: unknown };
}

/** The panel (U15) that holds the selection, or that is selected, with its position. */
export function selectedPanel(editor: Editor): SelectedPanel | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "panel") {
    return { pos: selection.from, attrs: selection.node.attrs as SelectedPanel["attrs"] };
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "panel") {
      return { pos: $from.before(depth), attrs: node.attrs as SelectedPanel["attrs"] };
    }
  }
  return null;
}

/** Changes attributes of the panel at `pos`. The selection stays where it is. */
export function setPanelAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>): void {
  const panel = editor.state.doc.nodeAt(pos);
  if (panel?.type.name !== "panel") return;
  editor
    .chain()
    .command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { ...panel.attrs, ...attrs });
      return true;
    })
    .run();
}
