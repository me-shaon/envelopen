import { CheckIcon, XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";

// Short confirmations for actions that change nothing visible on the page, or change
// it out of view: "Tag added.", "Workspace renamed.", "Copied.". Radix announces each
// toast through a status region, pauses the timer on hover and focus, and lets a swipe
// or Escape dismiss it. F8 moves focus to the toasts. Errors stay inline, next to the
// control that failed, so they are never only in a toast.

interface ToastItem {
  id: number;
  message: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Shows a short confirmation. Use a full sentence that names what changed. */
export function toast(message: string): void {
  // The same message twice in a row replaces the first, so a double click shows one.
  items = [...items.filter((item) => item.message !== message), { id: nextId++, message }].slice(
    -3,
  );
  emit();
}

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
    <ToastPrimitive.Provider duration={4000} swipeDirection="right" label="Notifications">
      {current.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          type="background"
          onOpenChange={(open) => {
            if (!open) setTimeout(() => dismiss(item.id), 200);
          }}
          className="toast pointer-events-auto flex items-center gap-2.5 rounded-xl bg-popover py-2.5 pr-2 pl-3 text-[13px] text-popover-foreground shadow-popover"
          data-testid="toast"
        >
          <span
            className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-tone-teal text-tone-teal-foreground"
            aria-hidden="true"
          >
            <CheckIcon className="size-2.5" strokeWidth={3} />
          </span>
          <ToastPrimitive.Description className="min-w-0 flex-1">
            {item.message}
          </ToastPrimitive.Description>
          <ToastPrimitive.Close
            aria-label="Dismiss"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-press) hover:bg-accent hover:text-foreground max-sm:size-11"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[60] m-0 flex w-full max-w-[380px] list-none flex-col gap-2 p-4 outline-none sm:p-6" />
    </ToastPrimitive.Provider>
  );
}
