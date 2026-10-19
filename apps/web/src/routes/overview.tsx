import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, CodeIcon, PlugZapIcon, SendIcon } from "lucide-react";
import { campaignsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { CampaignTable } from "@/features/campaigns/campaigns-page";
import { OnboardingChecklist, useOnboarding } from "@/features/onboarding/onboarding-checklist";
import { guideUrl } from "@/lib/guides";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// The KPI strip and the activity feed show their empty state until the stats unit
// (U11) adds their data.
const KPIS = [
  { label: "Delivered", color: "bg-chart-2" },
  { label: "Opened by people", color: "bg-chart-1" },
  { label: "Clicked", color: "bg-chart-3" },
  { label: "Unsubscribed", color: "bg-chart-4" },
];

function KpiStrip() {
  return (
    <section aria-labelledby="results-title" className="flex flex-col gap-4">
      <SectionHeader id="results-title" title="Latest campaign" aside="No campaign sent yet" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-xl border border-border">
        {KPIS.map((kpi, index) => (
          <div
            key={kpi.label}
            className={
              index > 0
                ? "flex flex-col gap-2 border-l border-border p-[18px]"
                : "flex flex-col gap-2 p-[18px]"
            }
          >
            <span className="text-xs text-muted-foreground">{kpi.label}</span>
            <span className="figure text-[26px] leading-[1.1] text-muted-foreground">-</span>
            <div className="h-[3px] overflow-hidden rounded-full bg-track">
              <div className={`h-[3px] w-0 rounded-full ${kpi.color}`} />
            </div>
            <span className="text-xs text-muted-foreground">No data yet</span>
          </div>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        Rates appear here after the first campaign is sent. Machine opens are counted apart from
        human opens.
      </span>
    </section>
  );
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
      {items.length > 0 ? (
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

export function OverviewPage() {
  const { current } = useCurrentWorkspace();
  const onboarding = useOnboarding();
  const left = onboarding.data ? onboarding.data.total - onboarding.data.completed : null;
  const subtitle =
    left === null
      ? `Workspace ${current.name}.`
      : left === 0
        ? "Setup is complete. You are ready to send."
        : `${left} setup ${left === 1 ? "step is" : "steps are"} left in ${current.name}.`;

  return (
    <div className="flex flex-wrap gap-12">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-12">
        <PageHeader title={greeting(new Date().getHours())} description={subtitle} />
        <OnboardingChecklist />
        <KpiStrip />
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
          <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
            <span className="mt-[5px] size-2 rounded-full bg-chart-2" aria-hidden="true" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] leading-[1.45]">Workspace {current.name} is ready.</span>
              <span className="text-xs text-muted-foreground">
                Sends, imports, and unsubscribes will show here.
              </span>
            </div>
          </div>
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
                className="flex min-h-8 items-center gap-2.5 text-[13px] text-muted-foreground hover:text-foreground"
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
