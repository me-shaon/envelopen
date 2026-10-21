import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { ApiRequestError, api, unwrap } from "@/api/client";
import { deploymentSettingsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

// The source link of the deployment (KTD16, AGPL section 13). The admin footer and every
// public subscriber page link here, with the version. It applies to every workspace.

const HTTPS_ERROR = "Enter a full URL that starts with https://.";

/** The same rule as the server: an absolute https URL with a host. */
function urlError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter the URL of the source code.";
  if (/\s/.test(trimmed)) return HTTPS_ERROR;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname === "") return HTTPS_ERROR;
    if (url.username !== "" || url.password !== "") return HTTPS_ERROR;
  } catch {
    return HTTPS_ERROR;
  }
  return null;
}

/** The server's message for the field, from the issues of an invalid_input error. */
function fieldError(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.code !== "invalid_input") return null;
  const issues = Array.isArray(error.details) ? error.details : [];
  const issue = issues.find(
    (item): item is { path: unknown[]; message: string } =>
      typeof item === "object" &&
      item !== null &&
      Array.isArray((item as { path?: unknown }).path) &&
      (item as { path: unknown[] }).path[0] === "sourceUrl",
  );
  return issue?.message ?? HTTPS_ERROR;
}

export function SourceCodeSection() {
  const queryClient = useQueryClient();
  const query = useQuery(deploymentSettingsQuery);
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.sourceUrl);
  }, [query.data, draft]);

  const save = useMutation({
    mutationFn: (sourceUrl: string) => unwrap(api.PATCH("/settings", { body: { sourceUrl } })),
    onSuccess: (data) => {
      setSaved(true);
      setTouched(false);
      setDraft(data.sourceUrl);
      queryClient.setQueryData(deploymentSettingsQuery.queryKey, data);
    },
  });

  const clientError = draft !== null && touched ? urlError(draft) : null;
  const serverError = fieldError(save.error);
  const error = clientError ?? serverError;
  const formError =
    save.error && serverError === null
      ? save.error instanceof Error
        ? save.error.message
        : "Something went wrong. Try again."
      : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    setTouched(true);
    if (urlError(draft)) return;
    save.mutate(draft.trim());
  }

  function update(value: string) {
    setSaved(false);
    save.reset();
    setDraft(value);
  }

  const defaultUrl = query.data?.defaultSourceUrl;

  return (
    <section id="source-code" aria-labelledby="source-code-title" className="flex flex-col gap-4">
      <SectionHeader
        id="source-code-title"
        title="Source code"
        aside="Applies to every workspace."
      />
      {draft === null ? (
        <LoadingRegion
          label="Loading the source code link"
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
        >
          <div className="flex max-w-[520px] flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32 rounded-sm" />
            <Skeleton className="h-9 rounded-[9px]" />
            <Skeleton className="h-3 w-80 max-w-full rounded-sm" />
          </div>
          <Skeleton className="h-9 w-[150px] rounded-[9px]" />
        </LoadingRegion>
      ) : (
        <form
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
          onSubmit={onSubmit}
          noValidate
        >
          <FormError message={formError} />
          <Field
            id="source-url"
            label="Source code URL"
            hint="The footer of the admin app and of each subscriber page links here, with the version. Envelopen uses the AGPL-3.0 license. If you change the code, link to your copy of it. Subscriber pages can show the old link for a few minutes."
            error={error}
            className="max-w-[520px]"
          >
            <Input
              id="source-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={draft}
              onChange={(event) => update(event.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "source-url-hint source-url-error" : "source-url-hint"}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" pending={save.isPending} disabled={clientError !== null}>
              Save source link
            </Button>
            {defaultUrl && draft.trim() !== defaultUrl ? (
              <Button type="button" variant="ghost" onClick={() => update(defaultUrl)}>
                Use the default
              </Button>
            ) : null}
            {saved ? (
              <span role="status" className="motion-enter text-[13px] text-muted-foreground">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
