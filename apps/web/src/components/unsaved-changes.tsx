import { type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import { ConfirmDialog } from "./ui/alert-dialog";

// Unsaved changes. While `when` is true, a move to another page in the app stops and
// asks first, in an app dialog. A tab close or a reload shows the browser's own prompt,
// because browsers allow no custom page there.

// A change of the search only (a tab, a filter) stays on the same page and does not ask.
const leavesPage: ShouldBlockFn = ({ current, next }) => current.pathname !== next.pathname;

export function UnsavedChangesGuard({ when, what }: { when: boolean; what: string }) {
  const blocker = useBlocker({
    shouldBlockFn: leavesPage,
    disabled: !when,
    enableBeforeUnload: when,
    withResolver: true,
  });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
      title="Leave without saving?"
      description={`Your changes to ${what} are not saved. If you leave this page, they are lost.`}
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
