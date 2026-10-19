import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "./button";

/** A confirmation for a destructive action. Focus starts on Cancel. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(26_25_23/0.28)] dark:bg-black/60" />
        <AlertDialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-32px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 rounded-2xl bg-popover p-6 text-popover-foreground shadow-popover">
          <div className="flex flex-col gap-1">
            <AlertDialogPrimitive.Title className="m-0 text-[17px] font-semibold tracking-[-0.02em]">
              {title}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="m-0 text-[13px] text-muted-foreground">
              {description}
            </AlertDialogPrimitive.Description>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline">Cancel</Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              variant="destructive"
              disabled={pending}
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
