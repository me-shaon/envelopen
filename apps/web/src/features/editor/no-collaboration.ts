import type { Transaction } from "@tiptap/pm/state";
import { PluginKey } from "@tiptap/pm/state";

// The drag handle (U14) supports Yjs collaboration, so it imports @tiptap/y-tiptap and
// @tiptap/extension-collaboration. Envelopen has no collaboration, so vite.config.ts
// points both imports here and Yjs stays out of the editor bundle. Without a Yjs sync
// plugin, the drag handle finds no sync state and uses plain position mapping.

/** A key that no plugin uses, so its state is always undefined. */
export const ySyncPluginKey = new PluginKey("y-sync");

/** No transaction comes from a Yjs sync. */
export function isChangeOrigin(_transaction: Transaction): boolean {
  return false;
}

/** Never called: the drag handle checks the sync state first. */
export function absolutePositionToRelativePosition(): null {
  return null;
}

/** Never called: the drag handle checks the sync state first. */
export function relativePositionToAbsolutePosition(): null {
  return null;
}
