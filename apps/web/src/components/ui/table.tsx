import { type ComponentProps, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Calm tables: a hairline frame, quiet column labels, and hairline row dividers.
// A table wider than the screen scrolls inside its frame. Then the right edge fades
// and a scroll hint shows under the table, so the hidden columns are easy to find. The frame takes
// keyboard focus while it scrolls, so arrow keys move it too.

function useOverflow() {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ overflow: false, atEnd: true });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const overflow = element.scrollWidth > element.clientWidth + 1;
      const atEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
      setState((value) =>
        value.overflow === overflow && value.atEnd === atEnd ? value : { overflow, atEnd },
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const table = element.firstElementChild;
    if (table) observer.observe(table);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return { ref, ...state };
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  const { ref, overflow, atEnd } = useOverflow();
  const label = props["aria-label"];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <div
          ref={ref}
          className="overflow-x-auto rounded-xl border border-border"
          // Focusable only while it scrolls: keyboard users can then scroll it.
          {...(overflow
            ? { tabIndex: 0, role: "region", "aria-label": label ? `${label}, scrolls` : undefined }
            : {})}
        >
          <table
            className={cn("w-full border-collapse text-left text-[13px]", className)}
            {...props}
          />
        </div>
        {overflow && !atEnd ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-xl bg-gradient-to-l from-background to-transparent"
          />
        ) : null}
      </div>
      {overflow ? (
        <span aria-hidden="true" className="self-end text-[11.5px] text-muted-foreground">
          Scroll sideways to see all columns
        </span>
      ) : null}
    </div>
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-hairline last:border-b-0", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}
