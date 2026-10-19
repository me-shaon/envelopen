import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PauseIcon, PlayIcon, SendIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { campaignBatchesQuery, campaignEstimateQuery, campaignQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, Figure } from "@/features/contacts/shared";
import { CampaignForm } from "./campaign-form";
import { ConfirmSendDialog } from "./confirm-dialog";
import {
  CAMPAIGN_TYPES,
  CampaignStatusPill,
  EXCLUSION_LABELS,
  formatUtc,
  formatWhen,
  PAUSE_REASONS,
} from "./shared";

// One campaign. A draft shows the form, the audience estimate, and "Review and send".
// Any other status shows the progress (R34, R39): sent, pending, and uncertain counts,
// the pause banner with its reason and, for platform_limit, the resume time, and the
// decision on uncertain batches (R38).

type Detail = Schemas["CampaignDetail"];

function BackLink() {
  return (
    <Link
      to="/campaigns"
      className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Campaigns
    </Link>
  );
}

function Header({ campaign, actions }: { campaign: Detail; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
              {campaign.name}
            </h1>
            <CampaignStatusPill status={campaign.status} />
          </div>
          <p className="m-0 text-[15px] text-muted-foreground">
            {CAMPAIGN_TYPES[campaign.type].label} campaign
            {campaign.provider ? ` through ${campaign.provider.name}` : ""}
            {campaign.startedAt ? `, started ${formatWhen(campaign.startedAt)}` : ""}
            {campaign.status === "scheduled"
              ? `, scheduled for ${formatWhen(campaign.scheduledAt)}`
              : ""}
          </p>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function CampaignPage({ campaignId }: { campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const campaign = useQuery(campaignQuery(current.id, campaignId));
  if (campaign.isPending) return <div className="h-40 rounded-xl border border-border bg-muted" />;
  if (!campaign.data) {
    return (
      <div className="flex flex-col gap-8">
        <BackLink />
        <FormError message={errorText(campaign.error) ?? "The campaign does not exist."} />
      </div>
    );
  }
  return campaign.data.status === "draft" ? (
    <DraftPage campaign={campaign.data} />
  ) : (
    <CampaignView campaign={campaign.data} />
  );
}

function DraftPage({ campaign }: { campaign: Detail }) {
  const [sending, setSending] = useState(false);
  return (
    <div className="flex flex-wrap gap-12">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-10">
        <Header campaign={campaign} />
        <CampaignForm
          key={campaign.version}
          campaign={campaign}
          aside={
            <Button type="button" onClick={() => setSending(true)}>
              <SendIcon className="size-3.5" aria-hidden="true" />
              Review and send
            </Button>
          }
        />
      </div>
      <aside
        aria-label="Audience estimate"
        className="flex max-w-[320px] flex-[1_1_260px] flex-col gap-4 pt-1"
      >
        <EstimatePanel campaign={campaign} />
      </aside>
      <ConfirmSendDialog campaign={campaign} open={sending} onOpenChange={setSending} />
    </div>
  );
}

function EstimatePanel({ campaign }: { campaign: Detail }) {
  const { current } = useCurrentWorkspace();
  const estimate = useQuery(campaignEstimateQuery(current.id, campaign.id, campaign.version));
  const data = estimate.data;
  const left = data
    ? (Object.entries(data.excluded) as [keyof typeof EXCLUSION_LABELS, number][]).filter(
        ([, n]) => n > 0,
      )
    : [];
  return (
    <section
      aria-labelledby="estimate-title"
      className="flex flex-col gap-3 rounded-xl border border-border p-[18px]"
    >
      <h2 id="estimate-title" className="m-0 text-[13px] font-semibold">
        Recipients
      </h2>
      <span className="figure text-[26px] leading-[1.1]" data-testid="draft-estimate">
        {data ? data.recipients.toLocaleString() : "-"}
      </span>
      <span className="text-xs text-muted-foreground">
        An estimate from the saved audience. The final list is taken when the send starts.
      </span>
      {left.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 border-t border-hairline p-0 pt-3">
          {left.map(([reason, count]) => (
            <li key={reason} className="text-xs text-muted-foreground">
              <span className="figure text-foreground">{count.toLocaleString()}</span> left out.{" "}
              {EXCLUSION_LABELS[reason]}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const KPI_COLORS = {
  sent: "bg-chart-2",
  pending: "bg-chart-3",
  uncertain: "bg-chart-1",
  skipped: "bg-chart-4",
};

function Kpis({ campaign }: { campaign: Detail }) {
  const { progress } = campaign;
  const total = Math.max(progress.total, campaign.recipientCount ?? 0);
  const items = [
    { key: "sent", label: "Sent", value: progress.sent },
    { key: "pending", label: "Pending", value: progress.pending },
    { key: "uncertain", label: "Uncertain", value: progress.uncertain },
    { key: "skipped", label: "Skipped or failed", value: progress.skipped + progress.failed },
  ] as const;
  return (
    <section aria-labelledby="progress-title" className="flex flex-col gap-4">
      <SectionHeader
        id="progress-title"
        title="Progress"
        aside={
          campaign.snapshotDone
            ? `${(campaign.recipientCount ?? total).toLocaleString()} recipients`
            : "Taking the recipient list"
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-xl border border-border">
        {items.map((item, index) => (
          <div
            key={item.key}
            className={
              index > 0
                ? "flex flex-col gap-2 border-l border-border p-[18px]"
                : "flex flex-col gap-2 p-[18px]"
            }
            data-testid={`kpi-${item.key}`}
          >
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <Figure value={item.value} className="text-[26px] leading-[1.1]" />
            <div className="h-[3px] overflow-hidden rounded-full bg-track">
              <div
                className={`h-[3px] rounded-full ${KPI_COLORS[item.key]}`}
                style={{ width: `${total > 0 ? Math.min(100, (item.value / total) * 100) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: "salmon" | "lavender" | "danger";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    salmon: "bg-tone-salmon text-tone-salmon-foreground",
    lavender: "bg-tone-lavender text-tone-lavender-foreground",
    danger: "bg-tone-danger text-tone-danger-foreground",
  };
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 ${tones[tone]}`}
      data-testid="campaign-banner"
    >
      <div className="flex min-w-0 flex-col gap-0.5 text-[13px]">
        <span className="font-semibold">{title}</span>
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}

function CampaignView({ campaign }: { campaign: Detail }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["ws", current.id, "campaigns"] });
  const action = useMutation({
    mutationFn: (verb: "pause" | "resume" | "cancel" | "unschedule") => {
      const params = { params: { path: { id: campaign.id } } };
      switch (verb) {
        case "pause":
          return unwrap(api.POST("/campaigns/{id}/pause", params));
        case "resume":
          return unwrap(api.POST("/campaigns/{id}/resume", params));
        case "cancel":
          return unwrap(api.POST("/campaigns/{id}/cancel", params));
        default:
          return unwrap(api.POST("/campaigns/{id}/unschedule", params));
      }
    },
    onSuccess: async () => {
      setCancelling(false);
      await refresh();
    },
  });
  const status = campaign.status;
  const cancellable =
    status === "scheduled" ||
    status === "sending" ||
    status === "paused" ||
    status === "needs_decision";
  const reason = campaign.pauseReason;

  return (
    <div className="flex flex-col gap-12">
      <Header
        campaign={campaign}
        actions={
          <>
            {status === "sending" ? (
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate("pause")}
              >
                <PauseIcon className="size-3.5" aria-hidden="true" />
                Pause
              </Button>
            ) : null}
            {status === "scheduled" ? (
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate("unschedule")}
              >
                Unschedule
              </Button>
            ) : null}
            {cancellable ? (
              <Button variant="ghost" onClick={() => setCancelling(true)}>
                Cancel campaign
              </Button>
            ) : null}
          </>
        }
      />
      <FormError message={errorText(action.error)} />

      {status === "paused" && reason ? (
        <Banner
          tone="salmon"
          title={PAUSE_REASONS[reason]}
          action={
            reason === "platform_limit" ? null : (
              <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("resume")}>
                <PlayIcon className="size-3.5" aria-hidden="true" />
                Resume
              </Button>
            )
          }
        >
          {reason === "platform_limit"
            ? `Sending resumes on its own after ${campaign.resumeAt ? formatUtc(campaign.resumeAt) : "00:00 UTC"}. Workers Paid has no daily limit.`
            : (campaign.pauseDetail ??
              `Paused ${formatWhen(campaign.pausedAt)}. Queued batches wait until you resume.`)}
        </Banner>
      ) : null}
      {status === "scheduled" ? (
        <Banner tone="lavender" title={`Scheduled for ${formatWhen(campaign.scheduledAt)}`}>
          Envelopen takes the recipient list and starts sending at that time. Unschedule to edit the
          campaign.
        </Banner>
      ) : null}
      {status === "needs_decision" ? (
        <Banner tone="danger" title="Some batches need your decision">
          The provider did not confirm every send. Decide below whether to retry or skip each batch.
        </Banner>
      ) : null}

      <Kpis campaign={campaign} />
      {(campaign.progress.batches.uncertain ?? 0) > 0 ? (
        <UncertainBatches campaign={campaign} />
      ) : null}
      <Exclusions campaign={campaign} />

      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel ${campaign.name}?`}
        description="No more emails go out. Recipients who got it keep it. You cannot undo this."
        confirmLabel="Cancel campaign"
        pending={action.isPending}
        onConfirm={() => action.mutate("cancel")}
      />
    </div>
  );
}

function Exclusions({ campaign }: { campaign: Detail }) {
  const rows = campaign.exclusions
    ? (Object.entries(campaign.exclusions) as [keyof typeof EXCLUSION_LABELS, number][]).filter(
        ([, n]) => n > 0,
      )
    : [];
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="left-out-title" className="flex flex-col gap-3">
      <SectionHeader id="left-out-title" title="Left out when the send started" />
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map(([reason, count]) => (
          <li key={reason} className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Pill>
              <Figure value={count} />
            </Pill>
            {EXCLUSION_LABELS[reason]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function UncertainBatches({ campaign }: { campaign: Detail }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const batches = useQuery({
    ...campaignBatchesQuery(current.id, campaign.id),
    refetchInterval: campaign.status === "sending" ? 3000 : false,
  });
  const [retrying, setRetrying] = useState<Schemas["CampaignBatch"] | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["ws", current.id, "campaigns"] });
  const decide = useMutation({
    mutationFn: ({
      batch,
      decision,
    }: {
      batch: Schemas["CampaignBatch"];
      decision: "retry" | "skip";
    }) => {
      const params = { path: { id: campaign.id, batchId: batch.id } };
      return decision === "retry"
        ? unwrap(
            api.POST("/campaigns/{id}/batches/{batchId}/retry", {
              params,
              body: { acceptDuplicateRisk: true },
            }),
          )
        : unwrap(api.POST("/campaigns/{id}/batches/{batchId}/skip", { params }));
    },
    onSuccess: async () => {
      setRetrying(null);
      await refresh();
    },
  });
  const items = batches.data?.items ?? [];

  return (
    <section aria-labelledby="uncertain-title" className="flex flex-col gap-4">
      <SectionHeader
        id="uncertain-title"
        title="Uncertain batches"
        aside="Other batches keep sending"
      />
      <p className="m-0 max-w-[640px] text-[13px] text-muted-foreground">
        The provider did not answer in time for these batches, so Envelopen does not know whether
        the emails went out. It never sends them again on its own. If you retry, people who already
        got the email get it a second time. If you skip, people who did not get it never will.
      </p>
      <FormError message={errorText(decide.error)} />
      {items.length === 0 && !batches.isPending ? (
        <EmptyState icon={UsersIcon} title="No uncertain batches">
          Every batch has a result.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0 overflow-hidden rounded-xl border border-border p-0">
          {items.map((batch) => (
            <li
              key={batch.id}
              data-testid="uncertain-batch"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium">
                  Batch {batch.seq}: <Figure value={batch.open} />{" "}
                  {batch.open === 1 ? "recipient" : "recipients"} with no result
                </span>
                <span className="text-xs text-muted-foreground">
                  {batch.open} {batch.open === 1 ? "person" : "people"} may get the email twice if
                  you retry.
                  {batch.lastError ? ` ${batch.lastError}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ batch, decision: "skip" })}
                >
                  Skip
                </Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => setRetrying(batch)}>
                  Retry
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={retrying !== null}
        onOpenChange={(open) => !open && setRetrying(null)}
        title="Retry this batch?"
        description={`Envelopen sends to ${retrying?.open ?? 0} people again. Some of them may already have the email, and they will get it twice.`}
        confirmLabel="Retry and accept duplicates"
        pending={decide.isPending}
        onConfirm={() => retrying && decide.mutate({ batch: retrying, decision: "retry" })}
      />
    </section>
  );
}

export function NewCampaignPage() {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
            New campaign
          </h1>
          <p className="m-0 text-[15px] text-muted-foreground">
            Save a draft first. You review the checks and confirm before anything is sent.
          </p>
        </div>
      </div>
      <CampaignForm />
    </div>
  );
}
