import { cn } from "@/lib/utils";

/** A small ring that turns while an action runs. It stays still under reduced motion. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-spinner=""
      className={cn("spinner size-3.5 shrink-0", className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A quiet "Updating" note next to data that is shown while newer data loads, so the
 * old rows stay in place instead of a skeleton.
 */
export function Refreshing({ active, label = "Updating" }: { active: boolean; label?: string }) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-opacity duration-[180ms]",
        active ? "opacity-100" : "opacity-0",
      )}
    >
      {active ? (
        <>
          <Spinner className="size-3" />
          {label}
        </>
      ) : null}
    </span>
  );
}
