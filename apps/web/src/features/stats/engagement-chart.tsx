import { useEffect, useRef, useState } from "react";
import { useFirstReveal, useSeen } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { formatCount, plural } from "./format";

// Engagement over the first 48 hours (R47), as plain SVG in the Calm hairline style:
// one thin bar pair per hour in the pastel data colors, hairline grid lines, and mono
// axis labels in HTML, so the text keeps its size while the plot stretches to the
// width. The x-axis fits the hours that have data (6, 12, 24, or 48 hours), so a new
// send does not show as a thin line at the left edge. A toggle shows the full 48 hours.
// Each hour has an invisible column with a native tooltip. Human opens and clicks only:
// machine opens and bot clicks are not drawn. The caption states the totals, and a
// table under the chart gives the same numbers as text.

export interface HourPoint {
  hour: number;
  opens: number;
  clicks: number;
  machineOpens: number;
}

const HOURS = 48;
const WIDTH = 480;
const HEIGHT = 120;
/** The x-axis windows, in hours, with their tick steps. */
interface AxisWindow {
  hours: number;
  step: number;
}
const FULL: AxisWindow = { hours: HOURS, step: 12 };
const WINDOWS: AxisWindow[] = [
  { hours: 6, step: 1 },
  { hours: 12, step: 3 },
  { hours: 24, step: 6 },
  FULL,
];

function lastActiveHour(hours: HourPoint[]): number {
  for (let index = hours.length - 1; index >= 0; index--) {
    const hour = hours[index];
    if (hour && (hour.opens > 0 || hour.clicks > 0 || hour.machineOpens > 0)) return index;
  }
  return -1;
}

/** The smallest window that holds every hour with data. */
function fitWindow(hours: HourPoint[]): AxisWindow {
  const needed = lastActiveHour(hours) + 1;
  return WINDOWS.find((item) => item.hours >= needed) ?? FULL;
}

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * magnitude >= value) ?? 10;
  return step * magnitude;
}

function barHeight(value: number, max: number): number {
  // A non-zero hour gets at least a sliver, so a single open stays visible.
  return value === 0 ? 0 : Math.max(2, (value / max) * (HEIGHT - 4));
}

export function EngagementChart({
  hours: all,
  revealKey,
}: {
  hours: HourPoint[];
  /** The bars grow from the baseline on the first view of this key in the session. */
  revealKey?: string;
}) {
  const [full, setFull] = useState(false);
  const plot = useRef<HTMLDivElement>(null);
  const first = useFirstReveal(revealKey ?? null);
  const seen = useSeen(plot, first);
  // The growth runs once. After it, new hours from a poll and the 48-hour toggle draw
  // their bars at once.
  const [growing, setGrowing] = useState(first);
  useEffect(() => {
    if (!growing || !seen) return;
    const timer = setTimeout(() => setGrowing(false), 900);
    return () => clearTimeout(timer);
  }, [growing, seen]);
  const fitted = fitWindow(all);
  const view = full ? FULL : fitted;
  const span = view.hours;
  const slot = WIDTH / span;
  const bar = slot * 0.3;
  const ticks = Array.from({ length: span / view.step + 1 }, (_, i) => i * view.step);
  const hours = all.slice(0, Math.min(span, HOURS));

  const opens = all.map((hour) => hour.opens);
  const clicks = all.map((hour) => hour.clicks);
  const max = niceMax(Math.max(1, ...hours.map((h) => h.opens), ...hours.map((h) => h.clicks)));
  const totalOpens = opens.reduce((sum, n) => sum + n, 0);
  const totalClicks = clicks.reduce((sum, n) => sum + n, 0);
  const peak = opens.indexOf(Math.max(...opens, 0));
  const elapsed = all.length === 1 ? "hour" : `${all.length} hours`;
  const summary =
    all.length === 0
      ? "No engagement yet."
      : `${plural(totalOpens, "open", "opens")} and ${plural(totalClicks, "click", "clicks")} by people in the first ${elapsed}.` +
        (totalOpens > 0 ? ` Opens peaked in hour ${peak + 1}.` : "");
  const active = all
    .map((hour, index) => ({ ...hour, index }))
    .filter((hour) => hour.opens > 0 || hour.clicks > 0 || hour.machineOpens > 0);

  return (
    <figure className="m-0 flex flex-col gap-3" data-testid="engagement-chart">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-chart-1" aria-hidden="true" />
            Opens by people
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-chart-3" aria-hidden="true" />
            Clicks by people
          </span>
        </div>
        {fitted.hours < HOURS ? (
          <button
            type="button"
            aria-pressed={full}
            onClick={() => setFull((value) => !value)}
            className="inline-flex min-h-[30px] items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground max-sm:min-h-11"
          >
            {full ? `Fit to ${fitted.hours} hours` : "Show all 48 hours"}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2">
        <div ref={plot} className="relative h-[140px]">
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            {[0, 0.5, 1].map((share) => {
              const y = HEIGHT - share * (HEIGHT - 4) - 0.5;
              return (
                <line
                  key={share}
                  x1={0}
                  x2={WIDTH}
                  y1={y}
                  y2={y}
                  className="stroke-hairline"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {ticks.slice(1, -1).map((tick) => (
              <line
                key={tick}
                x1={tick * slot}
                x2={tick * slot}
                y1={0}
                y2={HEIGHT}
                className="stroke-hairline"
                strokeWidth={1}
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hours.map((hour, index) => {
              const left = index * slot + (slot - 2 * bar) / 2;
              const open = barHeight(hour.opens, max);
              const click = barHeight(hour.clicks, max);
              // A short left-to-right stagger, 240 ms at most over the whole chart.
              const grow = growing
                ? {
                    className: seen ? "motion-grow-y" : "scale-y-0",
                    style: { animationDelay: `${Math.round((index / hours.length) * 240)}ms` },
                  }
                : { className: "", style: undefined };
              return (
                <g key={hour.hour}>
                  <rect
                    x={left}
                    y={HEIGHT - open}
                    width={bar}
                    height={open}
                    className={cn("fill-chart-1", grow.className)}
                    style={grow.style}
                  />
                  <rect
                    x={left + bar}
                    y={HEIGHT - click}
                    width={bar}
                    height={click}
                    className={cn("fill-chart-3", grow.className)}
                    style={grow.style}
                  />
                  <rect x={index * slot} y={0} width={slot} height={HEIGHT} fill="transparent">
                    <title>{`Hour ${index + 1}: ${plural(hour.opens, "open", "opens")}, ${plural(hour.clicks, "click", "clicks")}, ${plural(hour.machineOpens, "machine open", "machine opens")}`}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
        </div>
        <div
          className="figure flex h-[140px] flex-col justify-between text-[11px] text-muted-foreground"
          aria-hidden="true"
        >
          <span className="-mt-1.5">{formatCount(max)}</span>
          <span>{formatCount(max / 2)}</span>
          <span className="-mb-1.5">0</span>
        </div>
        <div
          className="figure relative mt-2 h-4 text-[11px] text-muted-foreground"
          aria-hidden="true"
        >
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className={cn(
                "absolute -translate-x-1/2",
                index === 0 && "translate-x-0",
                index === ticks.length - 1 && "-translate-x-full",
              )}
              style={{ left: `${(tick / span) * 100}%` }}
            >
              {tick}h
            </span>
          ))}
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">{summary}</figcaption>
      {active.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="inline-flex min-h-[30px] items-center font-medium hover:text-foreground max-sm:min-h-11">
            Show the numbers as a table
          </summary>
          <table className="mt-2 w-full max-w-[420px] border-collapse text-left">
            <caption className="sr-only">Opens and clicks by people, per hour</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Hour
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  Opens
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  Clicks
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Machine opens
                </th>
              </tr>
            </thead>
            <tbody className="figure text-foreground">
              {active.map((hour) => (
                <tr key={hour.index} className="border-b border-hairline last:border-b-0">
                  <th scope="row" className="py-1.5 pr-3 font-normal">
                    {hour.index + 1}
                  </th>
                  <td className="py-1.5 pr-3 text-right">{formatCount(hour.opens)}</td>
                  <td className="py-1.5 pr-3 text-right">{formatCount(hour.clicks)}</td>
                  <td className="py-1.5 text-right">{formatCount(hour.machineOpens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </figure>
  );
}
