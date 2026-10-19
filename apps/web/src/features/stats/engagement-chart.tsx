import { formatCount, plural } from "./format";

// Engagement over the first 48 hours (R47), as plain SVG in the Calm hairline style:
// one thin bar pair per hour in the pastel data colors, hairline grid lines, and mono
// axis labels in HTML, so the text keeps its size while the plot stretches to the
// width. Bars stay visible when only the first hours have data, which a line would not.
// Each hour has an invisible column with a native tooltip. Human opens and clicks only:
// machine opens and bot clicks are not drawn. The caption states the totals for screen
// readers.

export interface HourPoint {
  hour: number;
  opens: number;
  clicks: number;
  machineOpens: number;
}

const HOURS = 48;
const WIDTH = 480;
const HEIGHT = 120;
const SLOT = WIDTH / HOURS;
const BAR = SLOT * 0.3;
const TICKS = [0, 12, 24, 36, 48];

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

export function EngagementChart({ hours }: { hours: HourPoint[] }) {
  const opens = hours.map((hour) => hour.opens);
  const clicks = hours.map((hour) => hour.clicks);
  const max = niceMax(Math.max(1, ...opens, ...clicks));
  const totalOpens = opens.reduce((sum, n) => sum + n, 0);
  const totalClicks = clicks.reduce((sum, n) => sum + n, 0);
  const peak = opens.indexOf(Math.max(...opens, 0));
  const span = hours.length === 1 ? "hour" : `${hours.length} hours`;
  const summary =
    hours.length === 0
      ? "No engagement yet."
      : `${plural(totalOpens, "open", "opens")} and ${plural(totalClicks, "click", "clicks")} by people in the first ${span}.` +
        (totalOpens > 0 ? ` Opens peaked in hour ${peak + 1}.` : "");

  return (
    <figure className="m-0 flex flex-col gap-3" data-testid="engagement-chart">
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
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2">
        <div className="relative h-[140px]">
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
            {TICKS.slice(1, -1).map((tick) => (
              <line
                key={tick}
                x1={tick * SLOT}
                x2={tick * SLOT}
                y1={0}
                y2={HEIGHT}
                className="stroke-hairline"
                strokeWidth={1}
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hours.map((hour, index) => {
              const left = index * SLOT + (SLOT - 2 * BAR) / 2;
              const open = barHeight(hour.opens, max);
              const click = barHeight(hour.clicks, max);
              return (
                <g key={hour.hour}>
                  <rect
                    x={left}
                    y={HEIGHT - open}
                    width={BAR}
                    height={open}
                    className="fill-chart-1"
                  />
                  <rect
                    x={left + BAR}
                    y={HEIGHT - click}
                    width={BAR}
                    height={click}
                    className="fill-chart-3"
                  />
                  <rect x={index * SLOT} y={0} width={SLOT} height={HEIGHT} fill="transparent">
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
          {TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
              style={{ left: `${(tick / HOURS) * 100}%` }}
            >
              {tick}h
            </span>
          ))}
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">{summary}</figcaption>
    </figure>
  );
}
