import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// A block that slides open when it appears and folds shut when it goes, for banners and
// alerts. The height runs on grid rows, so the content keeps its natural height and the
// page below moves with it instead of jumping. While it folds, the content stays mounted.
// Under reduced motion the change is instant.

export function Reveal({
  show,
  children,
  className,
  appear = true,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
  /** Animate the first appearance too. Off for content that is there on page load. */
  appear?: boolean;
}) {
  const [mounted, setMounted] = useState(show);
  const [open, setOpen] = useState(show && !appear);
  // Clip only while the height moves, so focus rings inside are not cut off at rest.
  const [settled, setSettled] = useState(show && !appear);
  const kept = useRef<ReactNode>(children);
  if (show) kept.current = children;

  useEffect(() => {
    setSettled(false);
    if (show) {
      setMounted(true);
      // One frame closed, then open, so the transition has a start.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setOpen(true));
      });
      const timer = setTimeout(() => setSettled(true), 280);
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    }
    setOpen(false);
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [show]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity,translate] ease-(--ease-calm)",
        open
          ? "grid-rows-[1fr] opacity-100 duration-(--duration-reveal)"
          : "-translate-y-1 grid-rows-[0fr] opacity-0 duration-[200ms]",
        className,
      )}
      inert={!show || undefined}
    >
      <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")}>
        {show ? children : kept.current}
      </div>
    </div>
  );
}
