import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PauseIcon, PlayIcon, SendIcon, UsersIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { campaignBatchesQuery, campaignEstimateQuery, campaignQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { Reveal } from "@/components/ui/reveal";
import { KpiSkeleton, LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, Figure } from "@/features/contacts/shared";
import { CampaignEngagement, CampaignResults } from "@/features/stats/campaign-stats";
import { CampaignForm } from "./campaign-form";
import { ConfirmSendDialog, type SendNotice } from "./confirm-dialog";
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
            {campaign.parentId !== null ? (
              <>
                {" to non-openers of "}
                <Link
                  to="/campaigns/$campaignId"
                  params={{ campaignId: String(campaign.parentId) }}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  campaign #{campaign.parentId}
                </Link>
              </>
            ) : null}
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

function noticeText(notice: SendNotice): { title: string; body: string } {
  const people = `about ${notice.recipients.toLocaleString()} ${notice.recipients === 1 ? "person" : "people"}`;
  return notice.mode === "schedule"
    ? {
        title: `Scheduled for ${formatWhen(notice.scheduledAt)}.`,
        body: `Envelopen sends to ${people} at that time. Progress updates here.`,
      }
    : { title: `Sending to ${people}.`, body: "Progress updates here." };
}

export function CampaignPage({ campaignId }: { campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const campaign = useQuery(campaignQuery(current.id, campaignId));
  // The notice outlives the change from the draft page to the progress page.
  const [notice, setNotice] = useState<SendNotice | null>(null);
  const shown = notice?.campaignId === campaignId ? notice : null;
  const text = shown ? noticeText(shown) : null;

  let page: ReactNode;
  if (campaign.isPending) {
    page = <CampaignSkeleton />;
  } else if (!campaign.data) {
    page = (
      <div className="flex flex-col gap-8">
        <BackLink />
        <FormError message={errorText(campaign.error) ?? "The campaign does not exist."} />
      </div>
    );
  } else if (campaign.data.status === "draft") {
    page = <DraftPage campaign={campaign.data} onConfirmed={setNotice} />;
  } else {
    page = (
      <CampaignView
        campaign={campaign.data}
        notice={shown}
        onDismissNotice={() => setNotice(null)}
      />
    );
  }
  return (
    <>
      {/* Mounted before the send, so screen readers announce the change. */}
      <div role="status" className="sr-only">
        {text ? `${text.title} ${text.body}` : ""}
      </div>
      {page}
    </>
  );
}

/** The campaign page while it loads: the header, then the progress strip. */
function CampaignSkeleton() {
  return (
    <LoadingRegion label="Loading the campaign" className="flex flex-col gap-12">
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-[34px] w-[300px] max-w-[70%]" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-[360px] max-w-full rounded-sm" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-24 rounded-sm" />
        <KpiSkeleton label="Loading the progress" />
      </div>
    </LoadingRegion>
  );
}

/** The banner after the send or the schedule: the one place, with the button, in clay. */
function SendBanner({ notice, onDismiss }: { notice: SendNotice; onDismiss: () => void }) {
  const text = noticeText(notice);
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-brand/30 bg-tone-brand px-4 py-3 text-tone-brand-foreground"
      data-testid="send-banner"
    >
      <SendIcon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
        <span className="font-semibold">{text.title}</span>
        <span>
          {text.body}{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
            onClick={() => {
              const target = document.getElementById("progress");
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
              target?.focus({ preventScroll: true });
            }}
          >
            See the progress
          </button>
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="-my-1 -mr-2 text-tone-brand-foreground not-disabled:hover:bg-transparent not-disabled:hover:opacity-70"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

function DraftPage({
  campaign,
  onConfirmed,
}: {
  campaign: Detail;
  onConfirmed: (notice: SendNotice) => void;
}) {
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
      <ConfirmSendDialog
        campaign={campaign}
        open={sending}
        onOpenChange={setSending}
        onConfirmed={onConfirmed}
      />
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
      {data || !estimate.isPending ? (
        <span className="figure text-[26px] leading-[1.1]" data-testid="draft-estimate">
          {data ? data.recipients.toLocaleString() : "-"}
        </span>
      ) : (
        <Skeleton className="h-[29px] w-24" />
      )}
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
    <section
      id="progress"
      tabIndex={-1}
      aria-labelledby="progress-title"
      className="flex scroll-mt-6 flex-col gap-4 outline-none"
    >
      <SectionHeader
        id="progress-title"
        title="Progress"
        aside={
          campaign.snapshotDone
            ? `${(campaign.recipientCount ?? total).toLocaleString()} recipients`
            : "Taking the recipient list"
        }
      />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex flex-col gap-2 bg-background p-[18px]"
            data-testid={`kpi-${item.key}`}
          >
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <Figure value={item.value} className="text-[26px] leading-[1.1]" />
            <div className="h-[3px] overflow-hidden rounded-full bg-track">
              {/* The bar eases to each new count while the campaign sends. */}
              <div
                className={`h-[3px] rounded-full transition-[width] duration-700 ease-(--ease-calm) ${KPI_COLORS[item.key]}`}
                style={{ width: `${total > 0 ? Math.min(100, (item.value / total) * 100) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A state banner. It is in place on page load, and it slides in or folds away when the
 * status changes while the page is open.
 */
function Banner({
  show,
  tone,
  title,
  children,
  action,
}: {
  show: boolean;
  tone: "salmon" | "lavender" | "danger";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    // The negative margin cancels the page gap while the banner is folded, and the
    // padding restores it inside the fold, so the gap opens and closes with the banner.
    <Reveal show={show} appear={false} className="-mt-12">
      <div className="pt-12">
        <BannerBody tone={tone} title={title} action={action}>
          {children}
        </BannerBody>
      </div>
    </Reveal>
  );
}

function BannerBody({
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

function CampaignView({
  campaign,
  notice,
  onDismissNotice,
}: {
  campaign: Detail;
  notice: SendNotice | null;
  onDismissNotice: () => void;
}) {
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
    onSuccess: async (_data, verb) => {
      setCancelling(false);
      await refresh();
      // Pause, resume, and unschedule change the status in view. Cancel closes a dialog.
      if (verb === "cancel") toast(`Campaign "${campaign.name}" cancelled.`);
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
                pending={action.isPending && action.variables === "pause"}
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
                pending={action.isPending && action.variables === "unschedule"}
                disabled={action.isPending}
                onClick={() => action.mutate("unschedule")}
              >
                Unschedule
              </Button>
            ) : null}
            {cancellable ? (
              <Button
                variant="destructive-ghost"
                onClick={() => {
                  action.reset();
                  setCancelling(true);
                }}
              >
                Cancel campaign
              </Button>
            ) : null}
          </>
        }
      />
      <FormError message={cancelling ? null : errorText(action.error)} />

      {/* The send banner slides in after the confirm and folds away on dismiss. */}
      <Reveal show={notice !== null} className="-mt-12">
        <div className="pt-12">
          {notice ? <SendBanner notice={notice} onDismiss={onDismissNotice} /> : null}
        </div>
      </Reveal>
      <Banner
        show={status === "paused" && reason !== null}
        tone="salmon"
        title={reason ? PAUSE_REASONS[reason] : ""}
        action={
          reason === "platform_limit" ? null : (
            <Button
              size="sm"
              pending={action.isPending && action.variables === "resume"}
              disabled={action.isPending}
              onClick={() => action.mutate("resume")}
            >
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
      <Banner
        show={status === "scheduled" && notice === null}
        tone="lavender"
        title={`Scheduled for ${formatWhen(campaign.scheduledAt)}`}
      >
        Envelopen takes the recipient list and starts sending at that time. Unschedule to edit the
        campaign.
      </Banner>
      <Banner
        show={status === "needs_decision"}
        tone="danger"
        title="Some batches need your decision"
      >
        The provider did not confirm every send. Decide below whether to retry or skip each batch.
      </Banner>

      {campaign.startedAt !== null ? <CampaignResults campaignId={campaign.id} /> : null}
      <Kpis campaign={campaign} />
      {(campaign.progress.batches.uncertain ?? 0) > 0 ? (
        <UncertainBatches campaign={campaign} />
      ) : null}
      <Exclusions campaign={campaign} />
      {campaign.startedAt !== null ? <CampaignEngagement campaignId={campaign.id} /> : null}

      <ConfirmDialog
        open={cancelling}
        onOpenChange={(open) => {
          setCancelling(open);
          action.reset();
        }}
        title={`Cancel ${campaign.name}?`}
        description="No more emails go out. Recipients who got it keep it. You cannot undo this."
        confirmLabel="Cancel campaign"
        cancelLabel="Keep sending"
        pending={action.isPending}
        error={errorText(action.error)}
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
  const [deciding, setDeciding] = useState<{
    batch: Schemas["CampaignBatch"];
    decision: "retry" | "skip";
  } | null>(null);
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
    onSuccess: async (_data, { batch, decision }) => {
      setDeciding(null);
      await refresh();
      toast(
        decision === "retry"
          ? `Batch ${batch.seq} is sending again.`
          : `Batch ${batch.seq} skipped.`,
      );
    },
  });
  const items = batches.data?.items ?? [];
  const retrying = deciding?.decision === "retry" ? deciding.batch : null;

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
                  onClick={() => setDeciding({ batch, decision: "skip" })}
                >
                  Skip<span className="sr-only"> batch {batch.seq}</span>
                </Button>
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => setDeciding({ batch, decision: "retry" })}
                >
                  Retry<span className="sr-only"> batch {batch.seq}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deciding !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDeciding(null);
          decide.reset();
        }}
        title={retrying ? "Retry this batch?" : "Skip this batch?"}
        description={
          retrying
            ? `Envelopen sends to ${retrying.open} people again. Some of them may already have the email, and they will get it twice.`
            : `Envelopen marks the ${deciding?.batch.open ?? 0} open sends as not sent. People who did not get the email never will. You cannot undo this.`
        }
        confirmLabel={retrying ? "Retry and accept duplicates" : "Skip batch"}
        pending={decide.isPending}
        error={errorText(decide.error)}
        onConfirm={() => deciding && decide.mutate(deciding)}
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
