import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// A 2 px bar at the top of the window while a navigation waits, for example for the
// editor chunk. It shows only after 120 ms, so quick moves between pages show nothing.
// The page stays on screen and usable meanwhile: no full-page spinner.

type Phase = "idle" | "running" | "done";

export function RouteProgress() {
  const pending = useRouterState({ select: (state) => state.status === "pending" });
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    if (pending) {
      const timer = setTimeout(() => setPhase("running"), 120);
      return () => clearTimeout(timer);
    }
    setPhase((value) => (value === "running" ? "done" : "idle"));
  }, [pending]);

  useEffect(() => {
    if (phase !== "done") return;
    const timer = setTimeout(() => setPhase("idle"), 360);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "idle") return null;
  return (
    <div
      aria-hidden="true"
      data-testid="route-progress"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5"
    >
      <div
        className={cn(
          "h-full origin-left bg-foreground/55",
          phase === "running"
            ? "route-progress"
            : "opacity-0 transition-opacity delay-150 duration-200 ease-out",
        )}
      />
    </div>
  );
}
