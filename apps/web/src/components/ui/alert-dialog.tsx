import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button";
import { FormError } from "./field";

/**
 * A confirmation for a destructive action. Focus starts on Cancel, and Escape cancels.
 * The dialog stays open while the action runs. When the action fails, `error` shows in
 * the dialog, next to the buttons, and the dialog stays open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** The label of the safe choice, which has the focus when the dialog opens. */
  cancelLabel?: string;
  pending?: boolean;
  /** The error of the last try, shown in the dialog. */
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="motion-overlay fixed inset-0 z-50 bg-[rgb(26_25_23/0.28)] dark:bg-black/60" />
        <AlertDialogPrimitive.Content className="motion-pop fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-32px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-2xl bg-popover p-6 text-popover-foreground shadow-popover">
          <div className="flex flex-col gap-1">
            <AlertDialogPrimitive.Title className="m-0 text-[17px] font-semibold tracking-[-0.02em]">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="m-0 text-[13px] text-muted-foreground">
              {description}
            </AlertDialogPrimitive.Description>
          </div>
          <FormError message={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              variant="destructive"
              pending={pending}
              onClick={(event) => {
                // Keep the dialog open until the action finishes.
                event.preventDefault();
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
