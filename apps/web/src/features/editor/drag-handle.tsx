import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVerticalIcon } from "lucide-react";

// The drag handle (U14, KTD11): Tiptap's MIT drag handle shows next to the top-level
// block under the pointer. A drag with it is ProseMirror's own drag, so the drop cursor
// shows where the block lands and undo restores the old order. The handle needs a
// mouse. The keyboard and touch path is the Move up and Move down buttons.

/** Stable, so the handle plugin registers once. */
const POSITION = { placement: "left-start", strategy: "absolute" } as const;

export function BlockDragHandle({ editor }: { editor: Editor }) {
  return (
    <DragHandle editor={editor} className="block-drag-handle" computePositionConfig={POSITION}>
      <div
        title="Drag to move"
        aria-hidden="true"
        data-testid="drag-handle"
        className="mr-1.5 flex h-7 w-5 cursor-grab items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-press) hover:bg-accent hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" strokeWidth={1.8} />
      </div>
    </DragHandle>
  );
}
