import { cn } from "@/lib/utils";
import { barWidth, type CampaignStats, formatRate, plural } from "./format";

// The KPI strip of the Calm direction: large mono figures over hairline bars in the
// pastel data colors. The overview shows the four headline numbers of the latest
// campaign. The campaign view adds a second row with the detail numbers (R46).

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
}

export function KpiStrip({ items, label }: { items: Kpi[]; label: string }) {
  return (
    <ul
      aria-label={label}
      className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-xl border border-border p-0"
    >
      {items.map((kpi, index) => (
        <li
          key={kpi.key}
          data-testid={`stat-${kpi.key}`}
          className={cn("flex flex-col gap-2 p-[18px]", index > 0 && "border-l border-border")}
        >
          <span className="text-xs text-muted-foreground">{kpi.label}</span>
          <span
            className={cn(
              "figure leading-[1.1]",
              kpi.muted && kpi.value.length > 1
                ? "text-[17px] text-muted-foreground"
                : kpi.muted
                  ? "text-[26px] text-muted-foreground"
                  : "text-[26px]",
            )}
          >
            {kpi.value}
          </span>
          <div className="h-[3px] overflow-hidden rounded-full bg-track" aria-hidden="true">
            <div
              className={cn("h-[3px] rounded-full", kpi.color)}
              style={{ width: `${barWidth(kpi.share)}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{kpi.detail}</span>
        </li>
      ))}
    </ul>
  );
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
      share: stats.rates.clickToOpen,
      detail: "Clickers among people who opened",
      color: "bg-chart-3",
    },
    {
      key: "machine-opens",
      label: "Machine opens",
      value: stats.tracking.opens ? String(stats.machineOpens.toLocaleString()) : "-",
      share: stats.sent > 0 ? Math.min(1, stats.machineOpens / stats.sent) : null,
      detail: "Counted apart from people",
      color: "bg-chart-4",
    },
    {
      key: "bounced",
      label: "Bounced",
      value: formatRate(stats.rates.bounce),
      share: stats.rates.bounce,
      detail: `${stats.bouncesHard.toLocaleString()} hard, ${stats.bouncesSoft.toLocaleString()} soft`,
      color: "bg-chart-1",
    },
    {
      key: "complaints",
      label: "Complaints",
      value: formatRate(stats.rates.complaint),
      share: stats.rates.complaint,
      detail: plural(stats.complaints, "spam report", "spam reports"),
      color: "bg-chart-2",
    },
  ];
}
