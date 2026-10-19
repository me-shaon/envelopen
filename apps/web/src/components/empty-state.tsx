import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A quiet panel for a page or a section that has nothing to show yet. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-border px-6 py-8",
        className,
      )}
    >
      <span className="inline-flex size-9 items-center justify-center rounded-[10px] bg-tone-neutral text-tone-neutral-foreground">
        <Icon className="size-[18px]" strokeWidth={1.7} aria-hidden="true" />
      </span>
      <div className="flex max-w-[460px] flex-col gap-1">
        <p className="m-0 text-[14px] font-semibold tracking-[-0.01em]">{title}</p>
        {children ? <div className="text-[13px] text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
