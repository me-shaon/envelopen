import { useCountUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A figure that counts up to its value once. The final text reserves the width from
 * the first frame, so the count causes no layout shift. Screen readers get only the
 * final value.
 */
export function CountUp({
  value,
  format,
  armed,
  go,
  className,
}: {
  value: number;
  format: (value: number) => string;
  /** Start from zero. False shows the value at once. */
  armed: boolean;
  /** Run the count now, for example when the figure is on screen. */
  go: boolean;
  className?: string;
}) {
  const current = useCountUp(value, armed, go);
  const final = format(value);
  return (
    <span className={cn("relative inline-grid", className)}>
      <span className="sr-only">{final}</span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {final}
      </span>
      <span aria-hidden="true" className="col-start-1 row-start-1">
        {current === value ? final : format(current)}
      </span>
    </span>
  );
}
