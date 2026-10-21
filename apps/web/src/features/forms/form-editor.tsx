import {
  type FormPageForm,
  type FormPageView,
  recommendedFormHeight,
  renderFormPage,
} from "@envelopen/email-render/form-page";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { ApiRequestError, api, unwrap } from "@/api/client";
import {
  deploymentSettingsQuery,
  fieldsQuery,
  formQuery,
  formsQuery,
  listsQuery,
} from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { UnsavedChangesGuard } from "@/components/unsaved-changes";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { Segmented } from "@/features/editor/preview";
import { CopyValue } from "@/features/providers/shared";
import { type SignupForm, TurnstileNotice } from "./forms-page";

// The form editor (U8). The settings are on the left. On the right, a live preview renders
// the hosted page with the same renderer as the Worker, at 360 px (a phone) and 640 px
// (a column on a website), in each page state. The preview has no Turnstile script and no
// submit: an empty `sandbox` keeps it inert.

const DEFAULT_CONSENT =
  "I agree to get emails from this sender. I can unsubscribe at any time with the link in each email.";
const DEFAULT_SUCCESS = "Thank you. Your subscription is active.";

interface Draft {
  name: string;
  listIds: number[];
  fieldIds: number[];
  consentText: string;
  successMessage: string;
  origins: string;
  fromName: string;
  fromEmail: string;
  enabled: boolean;
}

function draftOf(form: SignupForm | null): Draft {
  return {
    name: form?.name ?? "",
    listIds: form?.listIds ?? [],
    fieldIds: form?.fieldIds ?? [],
    consentText: form?.consentText ?? DEFAULT_CONSENT,
    successMessage: form?.successMessage ?? DEFAULT_SUCCESS,
    origins: (form?.allowedOrigins ?? []).join("\n"),
    fromName: form?.fromName ?? "",
    fromEmail: form?.fromEmail ?? "",
    enabled: form?.enabled ?? false,
  };
}

function bodyOf(draft: Draft) {
  return {
    name: draft.name.trim(),
    listIds: draft.listIds,
    fieldIds: draft.fieldIds,
    consentText: draft.consentText.trim(),
    successMessage: draft.successMessage.trim(),
    allowedOrigins: draft.origins
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    fromName: draft.fromName.trim() || null,
    fromEmail: draft.fromEmail.trim() || null,
    enabled: draft.enabled,
  };
}

type PreviewState = "form" | "error" | "inbox" | "confirm" | "confirmed" | "expired";
type PreviewWidth = "360" | "640";

const PREVIEW_STATES: { id: PreviewState; label: string }[] = [
  { id: "form", label: "Form" },
  { id: "error", label: "Form with errors" },
  { id: "inbox", label: "Check your inbox" },
  { id: "confirm", label: "Confirm" },
  { id: "confirmed", label: "Confirmed" },
  { id: "expired", label: "Link expired" },
];

function previewView(state: PreviewState, form: FormPageForm): FormPageView {
  switch (state) {
    case "error":
      return {
        kind: "form",
        form,
        action: "#",
        siteKey: null,
        values: { email: "name@example", fields: {} },
        errors: [
          {
            target: "email",
            message: "Enter a valid email address, for example name@example.com.",
          },
        ],
      };
    case "inbox":
      return { kind: "inbox", form, backHref: "#" };
    case "confirm":
      return { kind: "confirm", form, action: "#" };
    case "confirmed":
      return { kind: "confirmed", form };
    case "expired":
      return { kind: "expired", form, action: "#", siteKey: null, canResend: true };
    default:
      return { kind: "form", form, action: "#", siteKey: null };
  }
}

function FormPreview({ form, height }: { form: FormPageForm; height: number }) {
  const settings = useQuery(deploymentSettingsQuery);
  const [width, setWidth] = useState<PreviewWidth>("360");
  const [state, setState] = useState<PreviewState>("form");
  const html = useMemo(
    () =>
      renderFormPage(previewView(state, form), {
        nonce: "preview",
        sourceUrl: settings.data?.sourceUrl ?? "#",
        version: __ENVELOPEN_VERSION__,
        embed: true,
      }),
    [form, state, settings.data?.sourceUrl],
  );
  return (
    <section aria-labelledby="form-preview-title" className="flex min-w-0 flex-col gap-3">
      <SectionHeader id="form-preview-title" title="Preview" aside={`${height} px high`} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Preview width"
          value={width}
          options={[
            { id: "360", label: "360 px" },
            { id: "640", label: "640 px" },
          ]}
          onChange={setWidth}
        />
        <NativeSelect
          aria-label="Page state"
          className="w-auto"
          value={state}
          onChange={(event) => setState(event.target.value as PreviewState)}
        >
          {PREVIEW_STATES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3">
        <iframe
          title={`Form preview at ${width} px`}
          data-testid="form-preview"
          sandbox=""
          srcDoc={html}
          width={Number(width)}
          height={height}
          className="mx-auto block rounded-lg border-0 bg-background"
        />
      </div>
    </section>
  );
}

function CheckList({
  legend,
  items,
  selected,
  onChange,
  empty,
}: {
  legend: string;
  items: { id: number; label: string; hint?: string }[];
  selected: number[];
  onChange: (ids: number[]) => void;
  empty: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">{legend}</legend>
      {items.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        items.map((item) => {
          const id = `${legend.toLowerCase().replaceAll(" ", "-")}-${item.id}`;
          return (
            <div key={item.id} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                checked={selected.includes(item.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected, item.id]
                      : selected.filter((value) => value !== item.id),
                  )
                }
              />
              <Label htmlFor={id} className="cursor-pointer font-normal">
                {item.label}
                {item.hint ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">{item.hint}</span>
                ) : null}
              </Label>
            </div>
          );
        })
      )}
    </fieldset>
  );
}

function Embed({ form }: { form: SignupForm }) {
  if (!form.hostedUrl || !form.embedSnippet) return null;
  return (
    <section aria-labelledby="form-embed-title" className="flex flex-col gap-3">
      <SectionHeader id="form-embed-title" title="Share and embed" />
      <Field id="hosted-link" label="Hosted page">
        <CopyValue label="hosted link" value={form.hostedUrl} testId="hosted-link" />
      </Field>
      <Field
        id="embed-snippet"
        label="Iframe snippet"
        hint={`Paste it into your website. The height of ${form.recommendedHeight} px fits every state of this form. Add the website's origin under "Websites that can embed the form".`}
      >
        <CopyValue label="iframe snippet" value={form.embedSnippet} testId="embed-snippet" />
      </Field>
    </section>
  );
}

function Editor({ form }: { form: SignupForm | null }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const lists = useQuery(listsQuery(current.id));
  const fields = useQuery(fieldsQuery(current.id));
  const forms = useQuery(formsQuery(current.id));
  const [draft, setDraft] = useState<Draft>(() => draftOf(form));
  const [saved, setSaved] = useState<Draft>(() => draftOf(form));
  const [deleting, setDeleting] = useState(false);
  const update = (change: Partial<Draft>) => setDraft((value) => ({ ...value, ...change }));
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: () =>
      form
        ? unwrap(api.PUT("/forms/{id}", { params: { path: { id: form.id } }, body: bodyOf(draft) }))
        : unwrap(api.POST("/forms", { body: bodyOf(draft) })),
    onSuccess: async (result) => {
      setSaved(draft);
      queryClient.setQueryData(formQuery(current.id, result.id).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "forms", "list"] });
      toast(form ? `Form "${result.name}" saved.` : `Form "${result.name}" created.`);
      if (!form) {
        await navigate({ to: "/forms/$formId", params: { formId: String(result.id) } });
      }
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/forms/{id}", { params: { path: { id: form?.id ?? 0 } } })),
    onSuccess: async () => {
      setDeleting(false);
      setSaved(draft);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "forms"] });
      toast(`Form "${form?.name}" deleted.`);
      await navigate({ to: "/forms" });
    },
  });

  const fieldItems = (fields.data?.items ?? []).map((field) => ({
    id: field.id,
    label: field.label,
    hint:
      field.type === "choice"
        ? "Single choice"
        : field.type === "multi"
          ? "Multiple choice"
          : undefined,
  }));
  const fieldDefs = fields.data?.items;
  const previewForm: FormPageForm = useMemo(
    () => ({
      name: draft.name.trim() || "Subscribe",
      consentText: draft.consentText,
      successMessage: draft.successMessage,
      fields: draft.fieldIds.flatMap((id) => {
        const field = fieldDefs?.find((item) => item.id === id);
        return field
          ? [
              {
                key: field.key,
                label: field.label,
                type: field.type,
                options: field.options.map((option) => ({ id: option.id, label: option.label })),
              },
            ]
          : [];
      }),
    }),
    [draft.name, draft.consentText, draft.successMessage, draft.fieldIds, fieldDefs],
  );
  const height = recommendedFormHeight(previewForm.fields);
  const fieldError =
    save.error instanceof ApiRequestError
      ? ((save.error.details as { field?: string } | undefined)?.field ?? null)
      : null;
  const errorOf = (name: string) => (fieldError === name ? errorText(save.error) : null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <div className="flex flex-col gap-8">
      <UnsavedChangesGuard
        when={changed && !save.isPending && !remove.isPending}
        what="this form"
      />
      <div className="flex flex-col gap-3">
        <Link
          to="/forms"
          className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Forms
        </Link>
        <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
          {form ? form.name : "New form"}
        </h1>
      </div>
      {forms.data && !forms.data.turnstileConfigured ? <TurnstileNotice /> : null}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,680px)]">
        <form
          className="flex min-w-0 flex-col gap-6"
          onSubmit={onSubmit}
          aria-label="Form settings"
        >
          <FormError message={fieldError ? null : errorText(save.error)} />
          <Field
            id="form-name"
            label="Name"
            hint="The title of the form page."
            error={errorOf("name")}
          >
            <Input
              id="form-name"
              required
              maxLength={100}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <CheckList
            legend="Lists"
            items={(lists.data?.items ?? []).map((list) => ({ id: list.id, label: list.name }))}
            selected={draft.listIds}
            onChange={(listIds) => update({ listIds })}
            empty="Create a list first. A confirmed subscriber joins the lists that you select."
          />
          {errorOf("listIds") ? (
            <p className="m-0 -mt-4 text-xs text-tone-danger-foreground">{errorOf("listIds")}</p>
          ) : null}
          <CheckList
            legend="Fields to ask"
            items={fieldItems}
            selected={draft.fieldIds}
            onChange={(fieldIds) => update({ fieldIds })}
            empty="No custom fields. The form asks only for the email address."
          />
          <Field
            id="form-consent"
            label="Consent text"
            hint="The form shows it above the button. A change starts a new consent version."
          >
            <Textarea
              id="form-consent"
              required
              maxLength={2000}
              className="min-h-20"
              value={draft.consentText}
              aria-describedby="form-consent-hint"
              onChange={(event) => update({ consentText: event.target.value })}
            />
          </Field>
          <Field
            id="form-success"
            label="Success message"
            hint="The page shows it after the subscriber confirms."
          >
            <Textarea
              id="form-success"
              required
              maxLength={500}
              className="min-h-16"
              value={draft.successMessage}
              aria-describedby="form-success-hint"
              onChange={(event) => update({ successMessage: event.target.value })}
            />
          </Field>
          <Field
            id="form-origins"
            label="Websites that can embed the form"
            hint="One origin on each line, for example https://www.example.com. Use https and no path."
            error={errorOf("allowedOrigins")}
          >
            <Textarea
              id="form-origins"
              className="min-h-16 font-mono text-[12.5px]"
              spellCheck={false}
              value={draft.origins}
              aria-describedby="form-origins-hint"
              aria-invalid={errorOf("allowedOrigins") ? true : undefined}
              onChange={(event) => update({ origins: event.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field id="form-from-name" label="From name" className="min-w-[180px] flex-1">
              <Input
                id="form-from-name"
                maxLength={100}
                placeholder={current.name}
                value={draft.fromName}
                onChange={(event) => update({ fromName: event.target.value })}
              />
            </Field>
            <Field
              id="form-from-email"
              label="From address"
              className="min-w-[220px] flex-1"
              hint="Empty sends from noreply on your first verified domain."
              error={errorOf("fromEmail")}
            >
              <Input
                id="form-from-email"
                type="email"
                maxLength={320}
                value={draft.fromEmail}
                aria-describedby="form-from-email-hint"
                onChange={(event) => update({ fromEmail: event.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="form-enabled"
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: checked === true })}
              aria-describedby="form-enabled-hint"
            />
            <div className="flex flex-col">
              <Label htmlFor="form-enabled" className="cursor-pointer">
                Form is on
              </Label>
              <span id="form-enabled-hint" className="text-xs text-muted-foreground">
                When the form is off, its page and embeds show "This form is not available".
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={save.isPending} disabled={!draft.name.trim()}>
              {form ? "Save form" : "Create form"}
            </Button>
            {form ? (
              <Button type="button" variant="destructive-outline" onClick={() => setDeleting(true)}>
                Delete form
              </Button>
            ) : null}
          </div>
          {form ? <Embed form={form} /> : null}
        </form>
        <FormPreview form={previewForm} height={height} />
      </div>
      {form ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${form.name}?`}
          description="The page and its embeds stop working, and unconfirmed signups are deleted. Subscribers who confirmed stay on your lists."
          confirmLabel="Delete form"
          pending={remove.isPending}
          error={errorText(remove.error)}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </div>
  );
}

export function FormEditorPage({ formId }: { formId: string }) {
  const { current } = useCurrentWorkspace();
  const id = formId === "new" ? null : Number(formId);
  const form = useQuery({ ...formQuery(current.id, id ?? 0), enabled: id !== null });
  if (id === null) return <Editor key="new" form={null} />;
  if (form.isError) {
    return (
      <p role="alert" className="m-0 text-[13px] text-muted-foreground">
        {errorText(form.error)}
      </p>
    );
  }
  if (!form.data) return <Skeleton className="h-96 w-full" />;
  return <Editor key={form.data.id} form={form.data} />;
}
