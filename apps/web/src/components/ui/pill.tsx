import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "teal" | "salmon" | "lavender" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-tone-neutral text-tone-neutral-foreground",
  teal: "bg-tone-teal text-tone-teal-foreground",
  salmon: "bg-tone-salmon text-tone-salmon-foreground",
  lavender: "bg-tone-lavender text-tone-lavender-foreground",
  danger: "bg-tone-danger text-tone-danger-foreground",
};

/** A small rounded status label. */
export function Pill({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
