import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Schemas } from "@/api/client";
import { onboardingQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Pill, type Tone } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { guideUrl } from "@/lib/guides";
import { cn } from "@/lib/utils";

// The onboarding checklist (U5): connect a provider, verify a domain, import contacts,
// and send a test. The onboarding.status operation derives each state.

type Step = Schemas["OnboardingStep"];
type StepId = Step["id"];
type Status = Step["status"];

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "teal" },
  todo: { label: "To do", tone: "neutral" },
  waiting: { label: "Waiting", tone: "lavender" },
  blocked: { label: "Blocked", tone: "salmon" },
};

const ACTIONS: Record<StepId, { label: string; to: "/connections" | "/contacts" | "/campaigns" }> =
  {
    connect_provider: { label: "Connect a provider", to: "/connections" },
    verify_domain: { label: "Add a domain", to: "/connections" },
    import_contacts: { label: "Import CSV", to: "/contacts" },
    send_test: { label: "Send a test", to: "/campaigns" },
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

function StepCard({ step, index }: { step: Step; index: number }) {
  const status = STATUS[step.status];
  const done = step.status === "done";
  const action = ACTIONS[step.id];
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
          {step.status === "todo" || step.status === "waiting" ? (
            <Link
              to={action.to}
              className="inline-flex min-h-[30px] items-center rounded-lg border border-input px-2.5 text-[12.5px] font-medium hover:bg-accent"
            >
              {action.label}
            </Link>
          ) : null}
          <a
            href={guideUrl(step.guide)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[30px] items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
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

export function OnboardingChecklist() {
  const onboarding = useOnboarding();
  const data = onboarding.data;

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
      ) : (
        <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 p-0">
          {data
            ? data.steps.map((step, index) => <StepCard key={step.id} step={step} index={index} />)
            : [0, 1, 2, 3].map((key) => (
                <li key={key} className="h-[260px] rounded-xl border border-border bg-muted" />
              ))}
        </ol>
      )}
    </section>
  );
}
