import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";

// Short messages about actions whose result is not in view: a row removed after a
// dialog closed, a copy to the clipboard, a page left after a save. When the result is
// already visible where the person looks, show no toast.
//
// Errors stay inline, next to the control that failed, while that control is on screen.
// `toast.error` is for the other case: an action from a row, a menu, or a dialog that
// already closed, where there is no place for an inline error. An error toast is
// announced at once (assertive), stays for 10 seconds, and can offer "Try again".
//
// `toast.undo` confirms a removal that is easy to reverse and offers "Undo" for
// 8 seconds. Use it instead of a confirmation dialog for low-risk removals.
//
// Radix pauses the timer on hover and focus, and lets a swipe or Escape dismiss a toast.
// F8 moves focus to the toasts. At most 3 show at once, and a repeated message replaces
// the earlier one, so a double click shows one toast.

type Tone = "success" | "danger";

interface ToastAction {
  label: string;
  /** What the action does, for screen readers that cannot reach the toast in time. */
  altText: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: ToastAction;
  duration: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function push(item: Omit<ToastItem, "id">) {
  items = [...items.filter((other) => other.message !== item.message), { ...item, id: nextId++ }];
  items = items.slice(-3);
  emit();
}

/** Shows a short confirmation. Use one sentence that names the object and the change. */
export function toast(message: string, options: { action?: ToastAction } = {}): void {
  push({ message, tone: "success", action: options.action, duration: 4000 });
}

/**
 * Shows an error when there is no place for it next to the control. Name the problem
 * and the recovery. `retry` adds a "Try again" button.
 */
toast.error = (message: string, options: { retry?: () => void } = {}): void => {
  push({
    message,
    tone: "danger",
    duration: 10_000,
    action: options.retry
      ? { label: "Try again", altText: "Try the action again", onClick: options.retry }
      : undefined,
  });
};

/** Confirms a removal and offers to reverse it. */
toast.undo = (message: string, onUndo: () => void): void => {
  push({
    message,
    tone: "success",
    duration: 8000,
    action: { label: "Undo", altText: "Undo the removal", onClick: onUndo },
  });
};

function dismiss(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getItems = () => items;

export function Toaster() {
  const current = useSyncExternalStore(subscribe, getItems, getItems);
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
      {current.map((item) => {
        const danger = item.tone === "danger";
        return (
          <ToastPrimitive.Root
            key={item.id}
            // Foreground toasts are announced at once. Errors need that, and so does
            // an Undo, which is only useful while the toast is there.
            type={danger || item.action ? "foreground" : "background"}
            duration={item.duration}
            onOpenChange={(open) => {
              if (!open) setTimeout(() => dismiss(item.id), 200);
            }}
            className="toast pointer-events-auto flex items-center gap-2.5 rounded-xl bg-popover py-2.5 pr-2 pl-3 text-[13px] text-popover-foreground shadow-popover"
            data-testid="toast"
            data-tone={item.tone}
          >
            {danger ? (
              <CircleAlertIcon
                className="size-[18px] shrink-0 fill-tone-danger text-tone-danger-foreground"
                strokeWidth={2}
                aria-hidden="true"
              />
            ) : (
              <span
                className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-tone-teal text-tone-teal-foreground"
                aria-hidden="true"
              >
                <CheckIcon className="size-2.5" strokeWidth={3} />
              </span>
            )}
            <ToastPrimitive.Description className="min-w-0 flex-1">
              {item.message}
            </ToastPrimitive.Description>
            {item.action ? (
              <ToastPrimitive.Action
                altText={item.action.altText}
                onClick={item.action.onClick}
                className="inline-flex min-h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] font-medium text-foreground underline-offset-4 transition-colors duration-(--duration-press) hover:bg-accent max-sm:min-h-11"
              >
                {item.action.label}
              </ToastPrimitive.Action>
            ) : null}
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-press) hover:bg-accent hover:text-foreground max-sm:size-11"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[60] m-0 flex w-full max-w-[380px] list-none flex-col gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none sm:p-6" />
    </ToastPrimitive.Provider>
  );
}
