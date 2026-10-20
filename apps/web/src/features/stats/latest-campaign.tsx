import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { latestStatsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { KpiSkeleton, Skeleton } from "@/components/ui/skeleton";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { formatWhen } from "@/features/campaigns/shared";
import { formatCount, plural } from "./format";
import { headlineKpis, type Kpi, KpiStrip } from "./kpi-strip";

// The overview's "Latest campaign" (U5 layout, U11 data): the headline numbers of the
// campaign that started last, with a link to its full report. Before the first send it
// shows the empty strip.

const EMPTY: Kpi[] = [
  { key: "delivered", label: "Delivered", color: "bg-chart-2" },
  { key: "opened", label: "Opened by people", color: "bg-chart-1" },
  { key: "clicked", label: "Clicked", color: "bg-chart-3" },
  { key: "unsubscribed", label: "Unsubscribed", color: "bg-chart-4" },
].map((kpi) => ({ ...kpi, value: "-", share: null, detail: "No data yet", muted: true }));

export function LatestCampaign() {
  const { current } = useCurrentWorkspace();
  const latest = useQuery(latestStatsQuery(current.id));
  const campaign = latest.data?.campaign ?? null;
  const stats = latest.data?.stats ?? null;

  if (latest.isPending) {
    return (
      <section aria-labelledby="results-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 id="results-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
            Latest campaign
          </h2>
          <Skeleton className="h-3.5 w-56 rounded-sm" />
        </div>
        <KpiSkeleton label="Loading the latest campaign results" />
        <Skeleton className="h-3 w-[60%] rounded-sm" />
      </section>
    );
  }

  if (!campaign || !stats) {
    return (
      <section aria-labelledby="results-title" className="flex flex-col gap-4">
        <SectionHeader id="results-title" title="Latest campaign" aside="No campaign sent yet" />
        <KpiStrip label="Latest campaign results" items={EMPTY} />
        <span className="text-xs text-muted-foreground">
          Rates appear here after the first campaign is sent. Machine opens are counted apart from
          human opens.
        </span>
      </section>
    );
  }

  const meta = [
    campaign.status === "sending" ? "Sending" : `Sent ${formatWhen(campaign.startedAt)}`,
    campaign.recipientCount === null
      ? null
      : plural(campaign.recipientCount, "recipient", "recipients"),
    stats.provider?.name ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-labelledby="results-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="results-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
            {campaign.name}
          </h2>
          <span className="text-[13px] text-muted-foreground">{meta}</span>
        </div>
        <Link
          to="/campaigns/$campaignId"
          params={{ campaignId: String(campaign.id) }}
          className="inline-flex items-center gap-1 text-[13px] font-medium hover:underline"
        >
          Full report
          <ChevronRightIcon className="size-3" strokeWidth={2.2} aria-hidden="true" />
        </Link>
      </div>
      <KpiStrip
        label="Latest campaign results"
        items={headlineKpis(stats)}
        revealKey={`latest-${campaign.id}`}
      />
      <span className="text-xs text-muted-foreground">
        {stats.tracking.opens
          ? `${formatCount(stats.machineOpens)} machine ${stats.machineOpens === 1 ? "open is" : "opens are"} counted apart from human opens.`
          : "Open tracking was off for this campaign."}
      </span>
    </section>
  );
}
