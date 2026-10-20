import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { Collapsible } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import type { Schemas } from "@/api/client";
import { onboardingQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Pill, type Tone } from "@/components/ui/pill";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { guideUrl } from "@/lib/guides";
import { cn } from "@/lib/utils";

// The onboarding checklist (U5): connect a provider, verify a domain, import contacts,
// and send a test. The onboarding.status operation derives each state. When every step
// is done, the checklist folds into one quiet line, and the owner can open it again.
// The steps then unfold under the line, and the height follows them.

type Step = Schemas["OnboardingStep"];
type StepId = Step["id"];
type Status = Step["status"];

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "teal" },
  todo: { label: "To do", tone: "neutral" },
  waiting: { label: "Waiting", tone: "lavender" },
  blocked: { label: "Blocked", tone: "salmon" },
};

const ACTIONS: Record<
  StepId,
  { label: string; to: "/connections" | "/connections/domains" | "/contacts"; hash?: string }
> = {
  connect_provider: { label: "Connect a provider", to: "/connections" },
  verify_domain: { label: "Add a domain", to: "/connections/domains" },
  import_contacts: { label: "Import CSV", to: "/contacts" },
  send_test: { label: "Send a test", to: "/connections", hash: "test-send" },
};

const chip =
  "rounded-[7px] bg-card px-2.5 py-1 text-[11px] font-medium shadow-raised text-foreground";
const sheet = "flex w-[132px] flex-col gap-[5px] rounded-lg bg-card p-2.5 shadow-raised";
const line = "h-1 rounded-sm bg-track";

/** A small drawing for each step, as in the Calm mockup. */
function Thumb({ id }: { id: StepId }) {
  const art: Record<StepId, { tone: string; body: ReactNode }> = {
    connect_provider: {
      tone: "bg-tone-lavender",
      body: (
        <div className="flex flex-col items-center gap-1.5">
          <span className={chip}>Amazon SES</span>
          <span className={cn(chip, "translate-x-3.5")}>Resend</span>
          <span className={cn(chip, "-translate-x-2")}>Postmark</span>
        </div>
      ),
    },
    verify_domain: {
      tone: "bg-tone-teal",
      body: (
        <div className={sheet}>
          {["SPF", "DKIM", "DMARC"].map((record) => (
            <span key={record} className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-muted-foreground">{record}</span>
              <span className="size-1.5 rounded-full bg-chart-2" />
            </span>
          ))}
        </div>
      ),
    },
    import_contacts: {
      tone: "bg-tone-salmon",
      body: (
        <div className={sheet}>
          <span className="font-mono text-[10px] text-muted-foreground">contacts.csv</span>
          <span className={line} />
          <span className={cn(line, "w-[78%]")} />
          <span className={cn(line, "w-[56%]")} />
        </div>
      ),
    },
    send_test: {
      tone: "bg-tone-neutral",
      body: (
        <div className={cn(sheet, "gap-1.5")}>
          <span className="h-1.5 w-[58%] rounded-sm bg-foreground" />
          <span className={line} />
          <span className={cn(line, "w-[70%]")} />
          <span className="h-3.5 w-[46%] rounded bg-chart-1" />
        </div>
      ),
    },
  };
  const { tone, body } = art[id];
  return (
    <div className={cn("flex h-[112px] items-center justify-center", tone)} aria-hidden="true">
      {body}
    </div>
  );
}

/** The button text of a step, or null when the owner cannot act on it now. */
function actionLabel(step: Step, label: string): string | null {
  if (step.status === "todo") return label;
  if (step.status === "waiting") return step.id === "verify_domain" ? "Check the records" : label;
  // A failing connection or a wrong DNS record: the fix is on the same page.
  if (step.status === "blocked" && step.id === "connect_provider") return "Check the connection";
  if (
    step.status === "blocked" &&
    step.id === "verify_domain" &&
    !step.detail.startsWith("Connect")
  ) {
    return "Fix the records";
  }
  return null;
}

function StepCard({ step, index }: { step: Step; index: number }) {
  const status = STATUS[step.status];
  const done = step.status === "done";
  const action = ACTIONS[step.id];
  const label = actionLabel(step, action.label);
  return (
    <li
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-testid={`onboarding-step-${step.id}`}
      data-status={step.status}
    >
      <Thumb id={step.id} />
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
              done
                ? "bg-tone-teal text-tone-teal-foreground"
                : "bg-tone-neutral text-tone-neutral-foreground",
            )}
            aria-hidden="true"
          >
            {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : index + 1}
          </span>
          <h3 className="m-0 text-[14px] font-semibold tracking-[-0.01em]">{step.title}</h3>
        </div>
        <div>
          <Pill tone={status.tone}>
            <span className="sr-only">Status: </span>
            {status.label}
          </Pill>
        </div>
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">{step.detail}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
          {label ? (
            <Link
              to={action.to}
              hash={action.hash}
              className="inline-flex min-h-[30px] max-sm:min-h-11 items-center rounded-lg border border-input px-2.5 text-[12.5px] font-medium hover:bg-accent"
            >
              {label}
            </Link>
          ) : null}
          <a
            href={guideUrl(step.guide)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[30px] max-sm:min-h-11 items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
          >
            Guide
            <span className="sr-only"> for {step.title} (opens in a new tab)</span>
            <ArrowUpRightIcon className="size-3" aria-hidden="true" />
          </a>
        </div>
      </div>
    </li>
  );
}

export function useOnboarding() {
  const { current } = useCurrentWorkspace();
  return useQuery(onboardingQuery(current.id));
}

function StepGrid({ steps }: { steps: Step[] }) {
  return (
    <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 p-0">
      {steps.map((step, index) => (
        <StepCard key={step.id} step={step} index={index} />
      ))}
    </ol>
  );
}

/** The folded checklist: one line once every step is done, with the steps under it. */
function SetupComplete({ steps, total }: { steps: Step[]; total: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <section aria-label="Setup" className="flex flex-col">
        <div
          data-testid="onboarding-complete"
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground"
        >
          <span
            className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-tone-teal text-tone-teal-foreground"
            aria-hidden="true"
          >
            <CheckIcon className="size-2.5" strokeWidth={3} />
          </span>
          <span>
            <span className="font-medium text-foreground">Setup complete.</span>{" "}
            <span className="figure">{total}</span> of <span className="figure">{total}</span> steps
            done.
          </span>
          <Collapsible.Trigger className="inline-flex min-h-[30px] items-center text-[12.5px] font-medium text-muted-foreground underline-offset-4 transition-colors duration-(--duration-press) hover:text-foreground hover:underline max-sm:min-h-11">
            {open ? "Hide the steps" : "Show the steps"}
          </Collapsible.Trigger>
        </div>
        <Collapsible.Content className="motion-collapsible">
          {/* Padding instead of a gap, so the space folds with the steps. */}
          <div className="pt-4">
            <StepGrid steps={steps} />
          </div>
        </Collapsible.Content>
      </section>
    </Collapsible.Root>
  );
}

// Remembers that setup was complete, so the loading state can take the shape of the
// one-line summary instead of four cards. A hint only: the query always decides.
const COMPLETE_KEY = "envelopen.setup-complete";

function readCompleteHint(workspaceId: number): boolean {
  try {
    return localStorage.getItem(`${COMPLETE_KEY}.${workspaceId}`) === "1";
  } catch {
    return false;
  }
}

function writeCompleteHint(workspaceId: number, complete: boolean) {
  try {
    if (complete) localStorage.setItem(`${COMPLETE_KEY}.${workspaceId}`, "1");
    else localStorage.removeItem(`${COMPLETE_KEY}.${workspaceId}`);
  } catch {
    // No storage: the loading state shows the cards.
  }
}

export function OnboardingChecklist() {
  const { current } = useCurrentWorkspace();
  const onboarding = useOnboarding();
  const data = onboarding.data;
  const complete = data ? data.completed >= data.total : undefined;

  useEffect(() => {
    if (complete !== undefined) writeCompleteHint(current.id, complete);
  }, [complete, current.id]);

  if (data && complete) {
    return <SetupComplete steps={data.steps} total={data.total} />;
  }

  if (!data && !onboarding.isError && readCompleteHint(current.id)) {
    return (
      <LoadingRegion label="Loading the setup status" className="flex items-center gap-2.5">
        <Skeleton className="size-[18px] rounded-full" />
        <Skeleton className="h-3.5 w-56 rounded-sm" />
      </LoadingRegion>
    );
  }

  return (
    <section aria-labelledby="onboarding-title" className="flex flex-col gap-4">
      <SectionHeader
        id="onboarding-title"
        title="Finish setting up"
        aside={
          data ? (
            <span data-testid="onboarding-progress">
              <span className="figure">{data.completed}</span> of{" "}
              <span className="figure">{data.total}</span> done
            </span>
          ) : null
        }
      />
      {onboarding.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          The checklist did not load. Reload the page to try again.
        </p>
      ) : data ? (
        <StepGrid steps={data.steps} />
      ) : (
        <LoadingRegion
          label="Loading the setup steps"
          className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
        >
          {[0, 1, 2, 3].map((key) => (
            <div
              key={key}
              className="flex h-[260px] flex-col overflow-hidden rounded-xl border border-border"
            >
              <Skeleton className="h-[112px] rounded-none" />
              <div className="flex flex-col gap-2.5 p-4">
                <Skeleton className="h-3.5 w-[60%] rounded-sm" />
                <Skeleton className="h-4 w-14 rounded-full" />
                <Skeleton className="h-3 w-[90%] rounded-sm" />
                <Skeleton className="h-3 w-[70%] rounded-sm" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      )}
    </section>
  );
}
