import { useRef } from "react";
import { CountUp } from "@/components/count-up";
import { useFirstReveal, useSeen } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { barWidth, type CampaignStats, formatCount, formatRate, plural } from "./format";

// The KPI strip of the Calm direction: large mono figures over hairline bars in the
// pastel data colors. The overview shows the four headline numbers of the latest
// campaign. The campaign view adds a compact second row with the detail numbers (R46).
// On the first view in a session, the figures count up and the bars grow from zero. A
// poll or a refetch shows new numbers in place, without a second count.

export interface Kpi {
  key: string;
  label: string;
  /** The large figure, usually a rate. */
  value: string;
  /** The bar, a share from 0 to 1. Null draws an empty track. */
  share: number | null;
  /** One line under the bar, for example "12 contacts". */
  detail: string;
  color: string;
  /** The figure is a word or a dash, not a number, for example "Not reported". */
  muted?: boolean;
  /** The number behind `value` and its format, so the figure can count up to it. */
  count?: { value: number; format: (value: number) => string };
}

export function KpiStrip({
  items,
  label,
  compact = false,
  revealKey,
}: {
  items: Kpi[];
  label: string;
  /** A quieter row for the secondary numbers: smaller figures and no bars. */
  compact?: boolean;
  /** Counts up on the first view of this key in the session. */
  revealKey?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const first = useFirstReveal(revealKey ?? null);
  const seen = useSeen(ref, first);
  return (
    <ul
      ref={ref}
      aria-label={label}
      // The 1 px gaps show the border color between the cells, so the lines stay whole
      // when the four cells wrap into two rows.
      className="m-0 grid list-none grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border p-0 md:grid-cols-4"
    >
      {items.map((kpi) => (
        <li
          key={kpi.key}
          data-testid={`stat-${kpi.key}`}
          className={cn(
            "flex flex-col bg-background",
            compact ? "gap-1 px-[18px] py-3" : "gap-2 p-[18px]",
          )}
        >
          <span className="text-xs text-muted-foreground">{kpi.label}</span>
          <span
            className={cn(
              "figure leading-[1.1]",
              compact
                ? kpi.muted
                  ? "text-[15px] text-muted-foreground"
                  : "text-[17px]"
                : kpi.muted && kpi.value.length > 1
                  ? "text-[17px] text-muted-foreground"
                  : kpi.muted
                    ? "text-[26px] text-muted-foreground"
                    : "text-[30px]",
            )}
          >
            {kpi.count && !kpi.muted ? (
              <CountUp value={kpi.count.value} format={kpi.count.format} armed={first} go={seen} />
            ) : (
              kpi.value
            )}
          </span>
          {compact ? null : (
            <div className="h-[3px] overflow-hidden rounded-full bg-track" aria-hidden="true">
              <div
                className={cn(
                  "h-[3px] rounded-full transition-[width] duration-500 ease-(--ease-calm)",
                  kpi.color,
                  first && (seen ? "motion-grow-x" : "scale-x-0"),
                )}
                style={{ width: `${barWidth(kpi.share)}%` }}
              />
            </div>
          )}
          <span className="text-xs text-muted-foreground">{kpi.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** A rate that can count up, or nothing when the rate has no base. */
function rate(value: number | null | undefined): Kpi["count"] {
  return value == null ? undefined : { value, format: formatRate };
}

function roundCount(value: number): string {
  return formatCount(Math.round(value));
}

/** Delivered, opened by people, clicked, and unsubscribed: the headline numbers. */
export function headlineKpis(stats: CampaignStats): Kpi[] {
  const delivered: Kpi =
    stats.delivered === null
      ? {
          key: "delivered",
          label: "Delivered",
          value: "Not reported",
          share: null,
          detail: `${stats.provider?.name ?? "The provider"} sends no delivery events`,
          color: "bg-chart-2",
          muted: true,
        }
      : {
          key: "delivered",
          label: "Delivered",
          value: formatRate(stats.rates.delivered),
          count: rate(stats.rates.delivered),
          share: stats.rates.delivered,
          detail: plural(stats.delivered, "inbox", "inboxes"),
          color: "bg-chart-2",
        };
  return [
    delivered,
    stats.tracking.opens
      ? {
          key: "opened",
          label: "Opened by people",
          value: formatRate(stats.rates.open),
          count: rate(stats.rates.open),
          share: stats.rates.open,
          detail: plural(stats.uniqueOpens, "contact", "contacts"),
          color: "bg-chart-1",
        }
      : {
          key: "opened",
          label: "Opened by people",
          value: "Not tracked",
          share: null,
          detail: "Open tracking was off",
          color: "bg-chart-1",
          muted: true,
        },
    stats.tracking.clicks
      ? {
          key: "clicked",
          label: "Clicked",
          value: formatRate(stats.rates.click),
          count: rate(stats.rates.click),
          share: stats.rates.click,
          detail: plural(stats.uniqueClicks, "contact", "contacts"),
          color: "bg-chart-3",
        }
      : {
          key: "clicked",
          label: "Clicked",
          value: "Not tracked",
          share: null,
          detail: "Click tracking was off",
          color: "bg-chart-3",
          muted: true,
        },
    {
      key: "unsubscribed",
      label: "Unsubscribed",
      value: formatRate(stats.rates.unsubscribe),
      count: rate(stats.rates.unsubscribe),
      share: stats.rates.unsubscribe,
      detail: plural(stats.unsubscribes, "contact", "contacts"),
      color: "bg-chart-4",
    },
  ];
}

/** Click-to-open, machine opens, bounces, and complaints: the detail numbers. */
export function detailKpis(stats: CampaignStats): Kpi[] {
  return [
    {
      key: "click-to-open",
      label: "Click-to-open",
      value: formatRate(stats.rates.clickToOpen),
      count: rate(stats.rates.clickToOpen),
      share: stats.rates.clickToOpen,
      detail: "Clickers among people who opened",
      color: "bg-chart-3",
    },
    {
      key: "machine-opens",
      label: "Machine opens",
      value: stats.tracking.opens ? String(stats.machineOpens.toLocaleString()) : "-",
      ...(stats.tracking.opens ? { count: { value: stats.machineOpens, format: roundCount } } : {}),
      share: stats.sent > 0 ? Math.min(1, stats.machineOpens / stats.sent) : null,
      detail: "Loaded by mail privacy tools, not people",
      color: "bg-chart-4",
    },
    {
      key: "bounced",
      label: "Bounced",
      value: formatRate(stats.rates.bounce),
      count: rate(stats.rates.bounce),
      share: stats.rates.bounce,
      detail: `${stats.bouncesHard.toLocaleString()} hard, ${stats.bouncesSoft.toLocaleString()} soft`,
      color: "bg-chart-1",
    },
    {
      key: "complaints",
      label: "Complaints",
      value: formatRate(stats.rates.complaint),
      count: rate(stats.rates.complaint),
      share: stats.rates.complaint,
      detail: plural(stats.complaints, "spam report", "spam reports"),
      color: "bg-chart-2",
    },
  ];
}
