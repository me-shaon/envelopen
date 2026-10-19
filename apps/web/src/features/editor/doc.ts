import type { BlockNode, EmailDocument } from "@envelopen/email-render/blocks/types";
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

// Helpers between the Tiptap editor and the email document.

/** The editor JSON is an EmailDocument: the extensions produce only its node types. */
export function documentOf(editor: Editor): EmailDocument {
  return editor.getJSON() as EmailDocument;
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

/** Inserts blocks after the current top-level block and selects the first new atom. */
export function insertBlocks(editor: Editor, blocks: BlockNode[]): void {
  const at = currentBlock(editor)?.end ?? editor.state.doc.content.size;
  editor
    .chain()
    .focus()
    .insertContentAt(at, blocks as JSONContent[])
    .command(({ tr }) => {
      const node = tr.doc.nodeAt(at);
      if (node?.isAtom) tr.setSelection(NodeSelection.create(tr.doc, at));
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
