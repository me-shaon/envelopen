import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Loading placeholders in the shape of the content that comes next. A skeleton appears
// after 150 ms (see `.skeleton` in styles.css), so a fast load shows no flash. It keeps
// its space from the first frame, so the content does not shift when it arrives. The
// shimmer stops under reduced motion.

/** Stable keys for a row of placeholders, which have no identity of their own. */
function slots(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/** One placeholder block. Size it with the classes of the content it stands for. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  // A span, so it can stand in for a figure inside text too.
  return <span aria-hidden="true" className={cn("skeleton block", className)} {...props} />;
}

/**
 * A region that is loading. Screen readers hear the label once. The placeholders inside
 * are hidden from them.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A table frame with header and body rows, as the Calm tables draw them. */
export function TableSkeleton({
  label,
  rows = 5,
  columns = 4,
}: {
  label: string;
  rows?: number;
  columns?: number;
}) {
  const widths = ["w-[46%]", "w-[30%]", "w-[22%]", "w-[38%]", "w-[18%]", "w-[26%]"];
  return (
    <LoadingRegion label={label} className="overflow-hidden rounded-xl border border-border">
      <div className="flex gap-6 border-b border-border px-4 py-3">
        {slots(columns, "head").map((key) => (
          <Skeleton key={key} className="h-3 flex-1 rounded-sm opacity-70" />
        ))}
      </div>
      {slots(rows, "row").map((rowKey, row) => (
        <div
          key={rowKey}
          className="flex items-center gap-6 border-b border-hairline px-4 py-[15px] last:border-b-0"
        >
          {slots(columns, "cell").map((cellKey, column) => (
            <div key={cellKey} className="flex flex-1">
              <Skeleton
                className={cn("h-3.5 rounded-sm", widths[(row + column * 2) % widths.length])}
              />
            </div>
          ))}
        </div>
      ))}
    </LoadingRegion>
  );
}

/** A KPI strip: a label, a large figure, a hairline track, and a detail line per cell. */
export function KpiSkeleton({ label, cells = 4 }: { label: string; cells?: number }) {
  return (
    <LoadingRegion
      label={label}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4"
    >
      {slots(cells, "kpi").map((key) => (
        <div key={key} className="flex flex-col gap-2 bg-background p-[18px]">
          <Skeleton className="h-3 w-20 rounded-sm" />
          <Skeleton className="h-[33px] w-24" />
          <div className="h-[3px] rounded-full bg-track" />
          <Skeleton className="h-3 w-28 rounded-sm" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** A stack of rows in a hairline frame, for lists that are not tables. */
export function ListSkeleton({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <LoadingRegion
      label={label}
      className={cn("flex flex-col overflow-hidden rounded-xl border border-border", className)}
    >
      {slots(rows, "row").map((key, row) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-3.5 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={cn("h-3.5 rounded-sm", row % 2 ? "w-[34%]" : "w-[44%]")} />
            <Skeleton className="h-3 w-[60%] rounded-sm" />
          </div>
          <Skeleton className="h-[30px] w-16" />
        </div>
      ))}
    </LoadingRegion>
  );
}
