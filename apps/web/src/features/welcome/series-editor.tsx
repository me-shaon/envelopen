import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ClockIcon,
  EyeIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ApiRequestError, api, unwrap } from "@/api/client";
import {
  listsQuery,
  templatePreviewQuery,
  templatesQuery,
  welcomeOverlapsQuery,
  welcomeSeriesQuery,
} from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { UnsavedChangesGuard } from "@/components/unsaved-changes";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { EmailPreview } from "@/features/editor/preview";
import { SendTestDialog } from "@/features/editor/send-test-dialog";
import { cn } from "@/lib/utils";
import type { WelcomeSeries } from "./welcome-page";

// The welcome series editor (U10, R15). The steps form a vertical list, with the wait
// before each email between them. Each step has a subject, a template with a preview,
// and a test send. The switch at the top turns the series on and shows how many contacts
// started it. Next to the list picker, a note says when another series list shares
// contacts with this one: a shared contact gets both series.

const MAX_STEPS = 5;
const MAX_DELAY_MINUTES = 30 * 24 * 60;

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

interface StepDraft {
  key: string;
  templateId: number | null;
  subject: string;
  delay: string;
  unit: Unit;
}

interface Draft {
  name: string;
  listId: number | null;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  steps: StepDraft[];
}

function splitDelay(minutes: number): { delay: string; unit: Unit } {
  if (minutes > 0 && minutes % UNIT_MINUTES.days === 0) {
    return { delay: String(minutes / UNIT_MINUTES.days), unit: "days" };
  }
  if (minutes > 0 && minutes % UNIT_MINUTES.hours === 0) {
    return { delay: String(minutes / UNIT_MINUTES.hours), unit: "hours" };
  }
  return { delay: String(minutes), unit: "minutes" };
}

function delayMinutes(step: StepDraft): number {
  const value = Number(step.delay);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * UNIT_MINUTES[step.unit]) : -1;
}

let stepKey = 0;
function newStep(first: boolean, templateId: number | null = null): StepDraft {
  stepKey += 1;
  return {
    key: `step-${stepKey}`,
    templateId,
    subject: "",
    delay: first ? "0" : "1",
    unit: first ? "minutes" : "days",
  };
}

function draftOf(series: WelcomeSeries | null, listId: number | null): Draft {
  return {
    name: series?.name ?? "Welcome",
    listId: series?.listId ?? listId,
    fromName: series?.fromName ?? "",
    fromEmail: series?.fromEmail ?? "",
    replyTo: series?.replyTo ?? "",
    steps: series
      ? series.steps.map((step) => {
          stepKey += 1;
          return {
            key: `step-${stepKey}`,
            templateId: step.templateId,
            subject: step.subject,
            ...splitDelay(step.delayMinutes),
          };
        })
      : [newStep(true)],
  };
}

/** The draft without the keys, to compare with the saved one. */
function comparable(draft: Draft) {
  return { ...draft, steps: draft.steps.map(({ key: _key, ...step }) => step) };
}

function bodyOf(draft: Draft) {
  return {
    name: draft.name.trim(),
    fromName: draft.fromName.trim() || null,
    fromEmail: draft.fromEmail.trim() || null,
    replyTo: draft.replyTo.trim() || null,
    steps: draft.steps.map((step) => ({
      templateId: step.templateId ?? 0,
      subject: step.subject.trim(),
      delayMinutes: delayMinutes(step),
    })),
  };
}

/**
 * The welcome template of the gallery (U15), rendered and saved as a block template for
 * email 1. It uses the brand kit. The gallery and the renderer load on first use.
 */
async function createWelcomeTemplate() {
  const [{ galleryTemplate }, { renderEmail }] = await Promise.all([
    import("@envelopen/email-render/gallery"),
    import("@envelopen/email-render/render"),
  ]);
  const welcome = galleryTemplate("welcome");
  if (!welcome) throw new Error("The welcome template is missing.");
  const doc = welcome.document();
  const rendered = await renderEmail(doc, { preheader: welcome.preheader });
  return unwrap(
    api.POST("/templates", {
      body: {
        name: welcome.name,
        subject: welcome.subject,
        preheader: welcome.preheader,
        format: "blocks",
        source: JSON.stringify(doc),
        html: rendered.html,
        text: rendered.text,
      },
    }),
  );
}

function EnableSwitch({
  series,
  disabled,
  hint,
}: {
  series: WelcomeSeries;
  disabled: boolean;
  hint: string | null;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const labelId = useId();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(
        api.POST("/welcome-series/{id}/enabled", {
          params: { path: { id: series.id } },
          body: { enabled },
        }),
      ),
    onSuccess: async (result) => {
      queryClient.setQueryData(welcomeSeriesQuery(current.id, result.id).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "welcome", "list"] });
      toast(result.enabled ? "The welcome series is on." : "The welcome series is off.");
    },
  });
  const enabled = toggle.data?.enabled ?? series.enabled;
  const entered = toggle.data?.entered ?? series.entered;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby={labelId}
            aria-describedby={`${labelId}-hint`}
            data-testid="welcome-switch"
            disabled={disabled || toggle.isPending}
            onClick={() => toggle.mutate(!enabled)}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-(--duration-press) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
              enabled ? "bg-primary" : "bg-input",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-5 rounded-full bg-card shadow-raised transition-transform duration-(--duration-press)",
                enabled ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </button>
          <span id={labelId} className="text-[14px] font-medium">
            {enabled ? "Series is on" : "Series is off"}
          </span>
        </div>
        <span className="figure text-[13px] text-muted-foreground" data-testid="welcome-entered">
          {entered === 1 ? "1 contact entered" : `${entered} contacts entered`}
        </span>
      </div>
      <p id={`${labelId}-hint`} className="m-0 text-xs text-muted-foreground">
        {hint ??
          (enabled
            ? "New subscribers from confirmed form signups, and adds with the start option, get the series. Turn it off to stop new starts. Contacts in the series stop at their next email."
            : "Turn it on to send the series to each new subscriber of the list.")}
      </p>
      <FormError message={errorText(toggle.error)} />
    </div>
  );
}

function OverlapNote({ listId, seriesId }: { listId: number; seriesId?: number }) {
  const { current } = useCurrentWorkspace();
  const overlaps = useQuery(welcomeOverlapsQuery(current.id, listId, seriesId));
  const items = overlaps.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="welcome-overlap"
      className="flex items-start gap-2 rounded-lg bg-tone-salmon px-3 py-2 text-[12.5px] text-tone-salmon-foreground"
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <p key={item.seriesId} className="m-0">
            {item.sharedContacts === 1
              ? "1 contact of this list is"
              : `${item.sharedContacts} contacts of this list are`}{" "}
            also on "{item.listName}", which has its own series. They get both series.
          </p>
        ))}
      </div>
    </div>
  );
}

function TemplatePreviewDialog({
  templateId,
  subject,
  onClose,
}: {
  templateId: number | null;
  subject: string;
  onClose: () => void;
}) {
  const { current } = useCurrentWorkspace();
  const preview = useQuery({
    ...templatePreviewQuery(current.id, templateId ?? 0),
    enabled: templateId !== null,
  });
  return (
    <Dialog open={templateId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-[760px]">
        <DialogHeader
          title="Template preview"
          description="The preview uses sample values. The subject is the step's subject."
        />
        {preview.isError ? (
          <FormError message={errorText(preview.error)} />
        ) : (
          <div className="max-h-[70vh] overflow-y-auto">
            <EmailPreview
              html={preview.data?.html ?? null}
              subject={subject || preview.data?.subject || ""}
              preheader={preview.data?.preheader ?? ""}
              missing={preview.data?.missing ?? []}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DelayControl({
  index,
  step,
  onChange,
}: {
  index: number;
  step: StepDraft;
  onChange: (change: Partial<StepDraft>) => void;
}) {
  const id = `welcome-delay-${step.key}`;
  const minutes = delayMinutes(step);
  const invalid = minutes < 0 || minutes > MAX_DELAY_MINUTES;
  return (
    <div className="flex items-center gap-3 py-2 pl-4" data-testid="welcome-delay">
      <span
        aria-hidden="true"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-tone-lavender text-tone-lavender-foreground"
      >
        <ClockIcon className="size-3.5" />
      </span>
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">
          {index === 0 ? "Wait before email 1" : `Wait before email ${index + 1}`}
        </legend>
        <label htmlFor={id} className="text-[13px] text-muted-foreground">
          {index === 0 ? "Wait after the contact joins" : "Then wait"}
        </label>
        <Input
          id={id}
          type="number"
          min={0}
          inputMode="numeric"
          className="w-20"
          value={step.delay}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => onChange({ delay: event.target.value })}
        />
        <NativeSelect
          aria-label={`Unit of the wait before email ${index + 1}`}
          className="w-auto"
          value={step.unit}
          onChange={(event) => onChange({ unit: event.target.value as Unit })}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </NativeSelect>
        {invalid ? (
          <span id={`${id}-error`} className="text-xs text-tone-danger-foreground">
            Use a wait from 0 minutes to 30 days.
          </span>
        ) : null}
      </fieldset>
    </div>
  );
}

function StepCard({
  index,
  step,
  count,
  templates,
  stats,
  onChange,
  onRemove,
  onPreview,
  onTest,
}: {
  index: number;
  step: StepDraft;
  count: number;
  templates: { id: number; name: string }[];
  stats: WelcomeSeries["stats"][number] | undefined;
  onChange: (change: Partial<StepDraft>) => void;
  onRemove: () => void;
  onPreview: () => void;
  onTest: () => void;
}) {
  const subjectId = `welcome-subject-${step.key}`;
  const templateId = `welcome-template-${step.key}`;
  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-4"
      data-testid="welcome-step"
      aria-labelledby={`${step.key}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${step.key}-title`} className="m-0 text-[14px] font-semibold">
          Email {index + 1}
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {stats ? (
            <span className="figure text-xs text-muted-foreground" data-testid="welcome-step-stats">
              {stats.sent} sent
              {stats.failed > 0 ? `, ${stats.failed} failed` : ""}
              {stats.skipped > 0 ? `, ${stats.skipped} stopped` : ""}
            </span>
          ) : null}
          {count > 1 ? (
            <Button type="button" variant="destructive-ghost" size="sm" onClick={onRemove}>
              Remove<span className="sr-only"> email {index + 1}</span>
            </Button>
          ) : null}
        </div>
      </div>
      <Field id={subjectId} label="Subject">
        <Input
          id={subjectId}
          required
          maxLength={200}
          placeholder='For example, Welcome, {{ first_name | default: "friend" }}'
          value={step.subject}
          onChange={(event) => onChange({ subject: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={templateId} label="Template" className="min-w-[220px] flex-1">
          <NativeSelect
            id={templateId}
            required
            value={step.templateId ?? ""}
            onChange={(event) =>
              onChange({ templateId: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">Select a template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={step.templateId === null}
          onClick={onPreview}
        >
          <EyeIcon className="size-3.5" aria-hidden="true" />
          Preview<span className="sr-only"> email {index + 1}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={step.templateId === null}
          onClick={onTest}
        >
          <SendIcon className="size-3.5" aria-hidden="true" />
          Send test<span className="sr-only"> of email {index + 1}</span>
        </Button>
      </div>
    </section>
  );
}

function Editor({ series, listId }: { series: WelcomeSeries | null; listId: number | null }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const lists = useQuery(listsQuery(current.id));
  const templates = useQuery(templatesQuery(current.id));
  const [draft, setDraft] = useState<Draft>(() => draftOf(series, listId));
  const [saved, setSaved] = useState<Draft>(() => draftOf(series, listId));
  const [deleting, setDeleting] = useState(false);
  const [previewing, setPreviewing] = useState<StepDraft | null>(null);
  const [testing, setTesting] = useState<StepDraft | null>(null);
  const update = (change: Partial<Draft>) => setDraft((value) => ({ ...value, ...change }));
  const updateStep = (key: string, change: Partial<StepDraft>) =>
    setDraft((value) => ({
      ...value,
      steps: value.steps.map((step) => (step.key === key ? { ...step, ...change } : step)),
    }));
  const changed = JSON.stringify(comparable(draft)) !== JSON.stringify(comparable(saved));
  const templateItems = templates.data?.items ?? [];

  const save = useMutation({
    mutationFn: () =>
      series
        ? unwrap(
            api.PUT("/welcome-series/{id}", {
              params: { path: { id: series.id } },
              body: bodyOf(draft),
            }),
          )
        : unwrap(
            api.POST("/welcome-series", { body: { ...bodyOf(draft), listId: draft.listId ?? 0 } }),
          ),
    onSuccess: async (result) => {
      setSaved(draft);
      queryClient.setQueryData(welcomeSeriesQuery(current.id, result.id).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "welcome", "list"] });
      toast(series ? `Series "${result.name}" saved.` : `Series "${result.name}" created.`);
      if (!series) {
        await navigate({ to: "/welcome/$seriesId", params: { seriesId: String(result.id) } });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/welcome-series/{id}", { params: { path: { id: series?.id ?? 0 } } })),
    onSuccess: async () => {
      setDeleting(false);
      setSaved(draft);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "welcome"] });
      toast(`Series "${series?.name}" deleted.`);
      await navigate({ to: "/welcome" });
    },
  });
  const starter = useMutation({
    mutationFn: createWelcomeTemplate,
    onSuccess: async (template) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "templates", "list"] });
      setDraft((value) => {
        const [first, ...rest] = value.steps;
        const filled = {
          ...(first ?? newStep(true)),
          templateId: template.id,
          subject: first?.subject || template.subject || "",
        };
        return { ...value, steps: [filled, ...rest] };
      });
      toast(`Template "${template.name}" created for email 1.`);
    },
  });

  const fieldError =
    save.error instanceof ApiRequestError
      ? ((save.error.details as { field?: string } | undefined)?.field ?? null)
      : null;
  const errorOf = (name: string) => (fieldError === name ? errorText(save.error) : null);
  const stepsValid = draft.steps.every((step) => {
    const minutes = delayMinutes(step);
    return (
      step.templateId !== null &&
      step.subject.trim() !== "" &&
      minutes >= 0 &&
      minutes <= MAX_DELAY_MINUTES
    );
  });
  const canSave = draft.name.trim() !== "" && draft.listId !== null && stepsValid;
  const listItems = lists.data?.items ?? [];
  const showStarter = !series && templates.isSuccess;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (canSave) save.mutate();
  }

  return (
    <div className="flex flex-col gap-8">
      <UnsavedChangesGuard
        when={changed && !save.isPending && !remove.isPending}
        what="this welcome series"
      />
      <div className="flex flex-col gap-3">
        <Link
          to="/welcome"
          className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Welcome series
        </Link>
        <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
          {series ? series.name : "New welcome series"}
        </h1>
      </div>
      {series ? (
        <EnableSwitch
          series={series}
          disabled={changed}
          hint={changed ? "Save your changes before you turn the series on or off." : null}
        />
      ) : null}
      <form
        className="flex max-w-[760px] flex-col gap-8"
        onSubmit={onSubmit}
        aria-label="Welcome series settings"
      >
        <FormError message={fieldError ? null : errorText(save.error)} />
        <section aria-labelledby="welcome-basics-title" className="flex flex-col gap-5">
          <SectionHeader id="welcome-basics-title" title="List and sender" />
          <Field id="welcome-name" label="Name" error={errorOf("name")}>
            <Input
              id="welcome-name"
              required
              maxLength={100}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <Field
              id="welcome-list"
              label="List"
              hint={
                series
                  ? "A series stays with its list."
                  : "Each list can have one series. New subscribers of this list get the series."
              }
            >
              <NativeSelect
                id="welcome-list"
                required
                disabled={series !== null}
                value={draft.listId ?? ""}
                aria-describedby="welcome-list-hint"
                onChange={(event) =>
                  update({ listId: event.target.value ? Number(event.target.value) : null })
                }
              >
                <option value="">Select a list</option>
                {listItems.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {draft.listId !== null ? (
              <OverlapNote listId={draft.listId} seriesId={series?.id} />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <Field id="welcome-from-name" label="From name" className="min-w-[180px] flex-1">
              <Input
                id="welcome-from-name"
                maxLength={100}
                placeholder={current.name}
                value={draft.fromName}
                onChange={(event) => update({ fromName: event.target.value })}
              />
            </Field>
            <Field
              id="welcome-from-email"
              label="From address"
              className="min-w-[220px] flex-1"
              hint="Empty sends from noreply on your first verified domain."
              error={errorOf("fromEmail")}
            >
              <Input
                id="welcome-from-email"
                type="email"
                maxLength={320}
                value={draft.fromEmail}
                aria-describedby="welcome-from-email-hint"
                onChange={(event) => update({ fromEmail: event.target.value })}
              />
            </Field>
          </div>
          <Field id="welcome-reply-to" label="Reply-to address" error={errorOf("replyTo")}>
            <Input
              id="welcome-reply-to"
              type="email"
              maxLength={320}
              value={draft.replyTo}
              onChange={(event) => update({ replyTo: event.target.value })}
            />
          </Field>
        </section>

        <section aria-labelledby="welcome-steps-title" className="flex flex-col gap-3">
          <SectionHeader
            id="welcome-steps-title"
            title="Emails"
            aside={`${draft.steps.length} of ${MAX_STEPS}`}
          />
          <p className="m-0 text-[13px] text-muted-foreground">
            Each contact gets each email once. A change applies to the emails that a contact has not
            received yet.
          </p>
          {showStarter ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3.5"
              data-testid="welcome-starter"
            >
              <div className="flex max-w-[460px] flex-col gap-0.5">
                <p className="m-0 text-[13.5px] font-medium">Start from the welcome template</p>
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  {templateItems.length === 0
                    ? "You have no templates yet. Envelopen can add the welcome template from the gallery for email 1. It uses your brand kit. Edit it later in Templates."
                    : "Envelopen can add the welcome template from the gallery for email 1. It uses your brand kit. Edit it later in Templates."}
                </p>
              </div>
              <Button
                type="button"
                variant="soft"
                size="sm"
                pending={starter.isPending}
                onClick={() => starter.mutate()}
              >
                <SparklesIcon className="size-3.5" aria-hidden="true" />
                Use the welcome template
              </Button>
              <FormError message={errorText(starter.error)} />
            </div>
          ) : null}
          {errorOf("steps") ? (
            <p className="m-0 text-xs text-tone-danger-foreground">{errorOf("steps")}</p>
          ) : null}
          <ol className="m-0 flex list-none flex-col p-0" aria-label="Emails of the series">
            {draft.steps.map((step, index) => (
              <li key={step.key} className="flex flex-col">
                <DelayControl
                  index={index}
                  step={step}
                  onChange={(change) => updateStep(step.key, change)}
                />
                <StepCard
                  index={index}
                  step={step}
                  count={draft.steps.length}
                  templates={templateItems}
                  stats={series?.stats.find((item) => item.position === index + 1)}
                  onChange={(change) => updateStep(step.key, change)}
                  onRemove={() =>
                    update({ steps: draft.steps.filter((item) => item.key !== step.key) })
                  }
                  onPreview={() => setPreviewing(step)}
                  onTest={() => setTesting(step)}
                />
              </li>
            ))}
          </ol>
          {draft.steps.length < MAX_STEPS ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => update({ steps: [...draft.steps, newStep(false)] })}
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add email
            </Button>
          ) : null}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" pending={save.isPending} disabled={!canSave}>
            {series ? "Save series" : "Create series"}
          </Button>
          {series ? (
            <Button type="button" variant="destructive-outline" onClick={() => setDeleting(true)}>
              Delete series
            </Button>
          ) : null}
        </div>
      </form>
      <TemplatePreviewDialog
        templateId={previewing?.templateId ?? null}
        subject={previewing?.subject ?? ""}
        onClose={() => setPreviewing(null)}
      />
      <SendTestDialog
        open={testing !== null}
        onOpenChange={(open) => (open ? undefined : setTesting(null))}
        prepare={async () => testing?.templateId ?? 0}
        subject={testing?.subject}
        description="Envelopen sends the template with this email's subject and the sample values of the preview."
      />
      {series ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${series.name}?`}
          description="No new contact starts the series, and contacts in it stop at their next email. The send history of the series is deleted."
          confirmLabel="Delete series"
          pending={remove.isPending}
          error={errorText(remove.error)}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </div>
  );
}

export function SeriesEditorPage({
  seriesId,
  listId,
}: {
  seriesId: string;
  listId?: number | undefined;
}) {
  const { current } = useCurrentWorkspace();
  const id = seriesId === "new" ? null : Number(seriesId);
  const series = useQuery({ ...welcomeSeriesQuery(current.id, id ?? 0), enabled: id !== null });
  if (id === null) return <Editor key="new" series={null} listId={listId ?? null} />;
  if (series.isError) {
    return (
      <p role="alert" className="m-0 text-[13px] text-muted-foreground">
        {errorText(series.error)}
      </p>
    );
  }
  if (!series.data) return <Skeleton className="h-96 w-full" />;
  return <Editor key={series.data.id} series={series.data} listId={null} />;
}
