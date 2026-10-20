import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ReplyIcon } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { campaignStatsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { KpiSkeleton, LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { ClickMap } from "./click-map";
import { EngagementChart } from "./engagement-chart";
import { type CampaignStats, formatCount, plural } from "./format";
import { detailKpis, headlineKpis, KpiStrip } from "./kpi-strip";

// The results of a campaign that has started (R46, R47, R50): the headline and detail
// numbers, the first 48 hours, the click map, and the follow-up to non-openers (R35).
// Every number comes from rollups that the event flush updates about every 30 seconds.

export function CampaignResults({ campaignId }: { campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const stats = useQuery(campaignStatsQuery(current.id, campaignId));
  const data = stats.data;
  if (!data) {
    return stats.isPending ? (
      <section aria-labelledby="results-title" className="flex flex-col gap-4">
        <h2 id="results-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          Results
        </h2>
        <KpiSkeleton label="Loading the results" />
        <Skeleton className="h-[62px] rounded-xl" />
      </section>
    ) : (
      <FormError message={errorText(stats.error)} />
    );
  }
  return (
    <section aria-labelledby="results-title" className="flex flex-col gap-4">
      <SectionHeader
        id="results-title"
        title="Results"
        aside={`${plural(data.sent, "email", "emails")} sent`}
      />
      <KpiStrip
        label="Headline results"
        items={headlineKpis(data)}
        revealKey={`results-${campaignId}`}
      />
      <KpiStrip
        label="Detail results"
        items={detailKpis(data)}
        compact
        revealKey={`details-${campaignId}`}
      />
      <ResultsNote stats={data} />
      <FollowUp stats={data} campaignId={campaignId} />
    </section>
  );
}

/** The first 48 hours and the click map. They share the stats query with the results. */
export function CampaignEngagement({ campaignId }: { campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const stats = useQuery(campaignStatsQuery(current.id, campaignId));
  if (!stats.data) {
    if (!stats.isPending) return null;
    return (
      <section aria-labelledby="engagement-title" className="flex flex-col gap-4">
        <h2 id="engagement-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          First 48 hours
        </h2>
        <LoadingRegion label="Loading the chart" className="flex flex-col gap-3">
          <Skeleton className="h-4 w-56 rounded-sm" />
          <Skeleton className="h-[164px] rounded-xl" />
        </LoadingRegion>
      </section>
    );
  }
  return (
    <>
      <section aria-labelledby="engagement-title" className="flex flex-col gap-4">
        <SectionHeader
          id="engagement-title"
          title="First 48 hours"
          aside="By the hour, from the start of the send"
        />
        <EngagementChart hours={stats.data.window.hours} revealKey={`chart-${campaignId}`} />
      </section>
      <ClickMap campaignId={campaignId} />
    </>
  );
}

function ResultsNote({ stats }: { stats: CampaignStats }) {
  const parts = [
    stats.tracking.opens
      ? `${plural(stats.machineOpens, "machine open is", "machine opens are")} counted apart from people, for example Apple Mail Privacy Protection.`
      : "Open tracking was off for this campaign.",
    stats.botClicks > 0
      ? `${plural(stats.botClicks, "click", "clicks")} by link scanners ${stats.botClicks === 1 ? "is" : "are"} left out.`
      : null,
    "New opens and clicks show here within about a minute.",
  ];
  return <p className="m-0 text-xs text-muted-foreground">{parts.filter(Boolean).join(" ")}</p>;
}

function FollowUp({ stats, campaignId }: { stats: CampaignStats; campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/campaigns/{id}/follow-up", { params: { path: { id: campaignId } } })),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "campaigns"] });
      await navigate({ to: "/campaigns/$campaignId", params: { campaignId: String(draft.id) } });
    },
  });
  const { available, reason } = stats.followUp;
  const nonOpeners = Math.max(0, stats.sent - stats.uniqueOpens);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5 text-[13px]">
        <span className="font-medium">Follow up with people who did not open</span>
        <span className="text-muted-foreground">
          {available
            ? `About ${formatCount(nonOpeners)} ${nonOpeners === 1 ? "person" : "people"}. Machine-only opens count as not opened. You review the draft and confirm before it sends.`
            : reason}
        </span>
        <FormError message={errorText(create.error)} />
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!available}
        pending={create.isPending}
        onClick={() => create.mutate()}
      >
        <ReplyIcon className="size-3.5" aria-hidden="true" />
        Create follow-up draft
      </Button>
    </div>
  );
}
