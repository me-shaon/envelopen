import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, CodeIcon, PlugZapIcon, SendIcon } from "lucide-react";
import type { Schemas } from "@/api/client";
import { campaignsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/ui/skeleton";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { RecentActivity } from "@/features/audit/recent-activity";
import { CampaignTable } from "@/features/campaigns/campaigns-page";
import { formatScheduled, formatWhen } from "@/features/campaigns/shared";
import { OnboardingChecklist, useOnboarding } from "@/features/onboarding/onboarding-checklist";
import { LatestCampaign } from "@/features/stats/latest-campaign";
import { guideUrl } from "@/lib/guides";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function RecentCampaigns({ workspaceId }: { workspaceId: number }) {
  const campaigns = useQuery(campaignsQuery(workspaceId, 5));
  const items = campaigns.data?.items ?? [];
  return (
    <section aria-labelledby="campaigns-title" className="flex flex-col gap-4">
      <SectionHeader
        id="campaigns-title"
        title="Recent campaigns"
        aside={
          items.length > 0 ? (
            <Link to="/campaigns" className="hover:text-foreground">
              All campaigns
            </Link>
          ) : null
        }
      />
      {campaigns.isPending ? (
        <TableSkeleton label="Loading the recent campaigns" rows={3} columns={5} />
      ) : items.length > 0 ? (
        <CampaignTable items={items} />
      ) : (
        <EmptyState
          icon={SendIcon}
          title="No campaigns yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/campaigns/new">Create a campaign</Link>
            </Button>
          }
        >
          Your drafts, scheduled sends, and sent campaigns will be listed here.
        </EmptyState>
      )}
    </section>
  );
}

const RESOURCES = [
  { label: "Provider guides", href: guideUrl("docs/guides/README.md"), icon: BookOpenIcon },
  { label: "API reference", href: "/api/openapi.json", icon: CodeIcon },
  {
    label: "Connect an MCP client",
    href: guideUrl("docs/guides/mcp.md"),
    icon: PlugZapIcon,
  },
];

/** The latest campaign in one line, for the subtitle after setup. */
function latestLine(campaign: Schemas["CampaignSummary"] | undefined): string | undefined {
  if (!campaign) return undefined;
  const name = `"${campaign.name}"`;
  switch (campaign.status) {
    case "sent":
      return `Latest campaign: ${name}, sent ${formatWhen(campaign.startedAt ?? campaign.updatedAt)}.`;
    case "sending":
      return `${name} is sending now.`;
    case "scheduled":
      return `${name} is scheduled for ${formatScheduled(campaign.scheduledAt, campaign.scheduledTimezone)}.`;
    case "paused":
      return `${name} is paused.`;
    case "needs_decision":
      return `${name} needs your decision.`;
    case "draft":
      return `Latest campaign: ${name}, a draft.`;
    default:
      return undefined;
  }
}

export function OverviewPage() {
  const { current } = useCurrentWorkspace();
  const onboarding = useOnboarding();
  // The same query as the recent campaigns list, so this costs no extra request.
  const campaigns = useQuery(campaignsQuery(current.id, 5));
  const left = onboarding.data ? onboarding.data.total - onboarding.data.completed : null;
  // When setup is complete, the checklist says so. The subtitle names the latest campaign.
  const subtitle =
    left === null
      ? `Workspace ${current.name}.`
      : left === 0
        ? latestLine(campaigns.data?.items[0])
        : `${left} setup ${left === 1 ? "step is" : "steps are"} left in ${current.name}.`;

  return (
    <div className="flex flex-wrap gap-12">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-12">
        <PageHeader title={greeting(new Date().getHours())} description={subtitle} />
        <OnboardingChecklist />
        <LatestCampaign />
        <RecentCampaigns workspaceId={current.id} />
      </div>

      <aside
        aria-label="Activity and resources"
        className="flex max-w-[300px] flex-[1_1_260px] flex-col gap-10 pt-1"
      >
        <section aria-labelledby="activity-title" className="flex flex-col gap-4">
          <h2 id="activity-title" className="m-0 text-[13px] font-semibold">
            Activity
          </h2>
          <RecentActivity workspaceId={current.id} />
        </section>

        <section aria-labelledby="resources-title" className="flex flex-col gap-2">
          <h2 id="resources-title" className="m-0 text-[13px] font-semibold">
            Resources
          </h2>
          {RESOURCES.map((resource) => {
            const Icon = resource.icon;
            return (
              <a
                key={resource.label}
                href={resource.href}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-8 max-sm:min-h-11 items-center gap-2.5 text-[13px] text-muted-foreground transition-colors duration-(--duration-press) hover:text-foreground"
              >
                <Icon className="size-[15px]" strokeWidth={1.7} aria-hidden="true" />
                {resource.label}
              </a>
            );
          })}
        </section>
      </aside>
    </div>
  );
}
