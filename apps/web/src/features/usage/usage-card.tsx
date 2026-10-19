import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { usageQuery } from "@/api/queries";
import { Pill } from "@/components/ui/pill";
import { barWidth, formatCount } from "@/features/stats/format";
import { cn } from "@/lib/utils";
import { formatCompact, USAGE_STATE } from "./shared";

// The sidebar card of the Calm direction: today's D1 writes against the Workers Free
// limit. It links to the usage page. Near the limit it shows the state as a pill.

export function UsageCard({ onNavigate }: { onNavigate?: () => void }) {
  const usage = useQuery(usageQuery);
  const data = usage.data;
  if (!data) return null;
  const { d1Writes } = data;
  return (
    <Link
      to="/usage"
      onClick={onNavigate}
      data-testid="usage-card"
      aria-label={`Free tier usage: ${formatCount(d1Writes.used)} of ${formatCount(d1Writes.limit)} D1 writes today`}
      className="flex flex-col gap-2 rounded-[10px] border border-sidebar-border bg-card p-3 transition-colors hover:border-border"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Free tier usage</span>
        {d1Writes.state !== "ok" ? (
          <Pill tone={USAGE_STATE[d1Writes.state].tone} className="px-[7px] py-px text-[11px]">
            {USAGE_STATE[d1Writes.state].label}
          </Pill>
        ) : null}
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-track" aria-hidden="true">
        <span
          className={cn(
            "block h-1 rounded-full",
            d1Writes.state === "ok" ? "bg-chart-2" : "bg-chart-1",
          )}
          style={{ width: `${barWidth(d1Writes.ratio)}%` }}
        />
      </span>
      <span className="text-xs text-sidebar-muted">
        <span className="figure text-sidebar-foreground">{formatCount(d1Writes.used)}</span> of{" "}
        {formatCompact(d1Writes.limit)} D1 writes
      </span>
    </Link>
  );
}
