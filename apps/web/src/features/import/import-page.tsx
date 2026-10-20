import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, DownloadIcon, FileUpIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { importQuery, listsQuery, tagsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Pill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import {
  CONSENT,
  type ConsentBasis,
  errorText,
  Figure,
  formatBytes,
  formatDateTime,
} from "@/features/contacts/shared";
import { cn } from "@/lib/utils";

// The CSV import flow (U6): upload, column mapping, the required consent basis and
// tags, a preview with counts, progress, and the error file. Each step is a call to the
// public API, and the import id in the URL lets a reload resume at the right step.

type Import = Schemas["Import"];
type Upload = Schemas["ImportUpload"];
type Counts = NonNullable<Import["preview"]>;

const MAX_BYTES = 5 * 1024 * 1024;
const FREE_DAILY_WRITES = 100_000;

const STEPS = ["Upload", "Map columns", "Consent and tags", "Preview", "Import"] as const;
/** The active step. 5 means every step is done. */
type StepIndex = number;

function Stepper({ active }: { active: StepIndex }) {
  return (
    <ol className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0" aria-label="Import steps">
      {STEPS.map((label, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <li
            key={label}
            className="flex items-center gap-2 text-[13px]"
            aria-current={current ? "step" : undefined}
          >
            <span
              className={cn(
                "inline-flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold",
                done
                  ? "bg-tone-teal text-tone-teal-foreground"
                  : current
                    ? "bg-foreground text-background"
                    : "bg-tone-neutral text-tone-neutral-foreground",
              )}
              aria-hidden="true"
            >
              {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : index + 1}
            </span>
            <span className={current ? "font-medium" : "text-muted-foreground"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-6 rounded-xl border border-border p-6", className)}>
      {children}
    </div>
  );
}

// Upload ---------------------------------------------------------------------------------

function UploadStep({ onUploaded }: { onUploaded: (upload: Upload) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (input: { filename: string; content: string }) =>
      unwrap(api.POST("/imports", { body: input })),
    onSuccess: onUploaded,
  });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setProblem(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem("The file is larger than 5 MB. Split it into smaller files.");
      return;
    }
    upload.mutate({ filename: file.name, content: await file.text() });
  }

  return (
    <Panel>
      <SectionHeader id="upload-title" title="Upload a CSV" />
      <FormError message={problem ?? errorText(upload.error)} />
      <label
        htmlFor="csv-file"
        className="flex cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-input bg-muted/50 px-6 py-12 text-center hover:bg-muted"
      >
        <span className="inline-flex size-10 items-center justify-center rounded-[10px] bg-tone-salmon text-tone-salmon-foreground">
          <FileUpIcon className="size-5" strokeWidth={1.7} aria-hidden="true" />
        </span>
        <span className="text-[14px] font-medium">
          {upload.isPending ? "Uploading" : "Choose a CSV file"}
        </span>
        <span className="max-w-[420px] text-xs text-muted-foreground">
          The first row must name the columns. Comma, semicolon, and tab separators work. Up to 5
          MB. Nothing is imported until you confirm the preview.
        </span>
      </label>
      <input
        id="csv-file"
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(event) => void onFile(event)}
        disabled={upload.isPending}
      />
    </Panel>
  );
}

// Mapping --------------------------------------------------------------------------------

function fieldKey(header: string): string {
  const slug = header
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return /^[a-z]/.test(slug) ? slug : `f_${slug || "column"}`;
}

function MappingStep({
  item,
  sample,
  mapping,
  onChange,
  onNext,
}: {
  item: Import;
  sample: string[][];
  mapping: string[];
  onChange: (mapping: string[]) => void;
  onNext: () => void;
}) {
  const emailColumns = mapping.filter((target) => target === "email").length;
  const problem =
    emailColumns === 0
      ? "Choose the column that holds the email address."
      : emailColumns > 1
        ? "Only one column can be the email address."
        : null;
  return (
    <Panel>
      <SectionHeader
        id="map-title"
        title="Map the columns"
        aside={
          <>
            {item.filename} · {formatBytes(item.sizeBytes)}
          </>
        }
      />
      <Table aria-label="Column mapping">
        <thead>
          <tr>
            <TableHead>Column in the file</TableHead>
            <TableHead>First rows</TableHead>
            <TableHead className="w-[220px]">Import as</TableHead>
          </tr>
        </thead>
        <tbody>
          {item.headers.map((header, index) => (
            // Columns keep their position, and two columns can share a name.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the column identity.
            <TableRow key={index}>
              <TableCell className="font-medium">{header}</TableCell>
              <TableCell className="max-w-[320px] text-muted-foreground">
                <span className="block truncate font-mono text-xs">
                  {sample
                    .map((row) => row[index] ?? "")
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(" · ") || "-"}
                </span>
              </TableCell>
              <TableCell>
                <NativeSelect
                  aria-label={`Import ${header} as`}
                  value={mapping[index] ?? "ignore"}
                  onChange={(event) => {
                    const next = [...mapping];
                    next[index] = event.target.value;
                    onChange(next);
                  }}
                >
                  <option value="email">Email address</option>
                  <option value="first_name">First name</option>
                  <option value="last_name">Last name</option>
                  <option value={`field:${fieldKey(header)}`}>
                    Custom field: {fieldKey(header)}
                  </option>
                  <option value="ignore">Skip this column</option>
                </NativeSelect>
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground" role={problem ? "alert" : undefined}>
          {problem ?? "Addresses are trimmed and lowercased before the import."}
        </span>
        <Button onClick={onNext} disabled={problem !== null}>
          Continue
        </Button>
      </div>
    </Panel>
  );
}

// Consent and tags -----------------------------------------------------------------------

interface Settings {
  consentBasis: ConsentBasis | null;
  tags: string;
  listIds: number[];
}

function ConsentStep({
  settings,
  onChange,
  onBack,
  onPreview,
  pending,
  error,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onBack: () => void;
  onPreview: () => void;
  pending: boolean;
  error: unknown;
}) {
  const { current } = useCurrentWorkspace();
  const lists = useQuery(listsQuery(current.id));
  const tags = useQuery(tagsQuery(current.id));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (settings.consentBasis) onPreview();
  }

  return (
    <form onSubmit={onSubmit}>
      <Panel>
        <SectionHeader id="consent-title" title="Consent basis and tags" />
        <FormError message={errorText(error)} />
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 text-[13px] font-medium">
            Why may you email these contacts?{" "}
            <span className="text-muted-foreground">Required</span>
          </legend>
          <p className="m-0 mb-2 text-xs text-muted-foreground">
            Envelopen stores the basis on each new contact with the import as the source and today's
            date. It does not lower the basis of existing contacts.
          </p>
          <RadioGroup
            value={settings.consentBasis ?? ""}
            onValueChange={(value) =>
              onChange({ ...settings, consentBasis: value as ConsentBasis })
            }
            aria-label="Consent basis"
          >
            {(Object.keys(CONSENT) as ConsentBasis[]).map((key) => (
              <div
                key={key}
                className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
              >
                <RadioGroupItem id={`basis-${key}`} value={key} />
                <Label htmlFor={`basis-${key}`} className="flex cursor-pointer flex-col">
                  <span>{CONSENT[key].label}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {CONSENT[key].detail}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>

        <Field
          id="import-tags"
          label="Tags"
          hint="Separate tags with commas, for example the course name. New tags are created."
        >
          <Input
            id="import-tags"
            list="import-tag-options"
            value={settings.tags}
            onChange={(event) => onChange({ ...settings, tags: event.target.value })}
            aria-describedby="import-tags-hint"
          />
          <datalist id="import-tag-options">
            {(tags.data?.items ?? []).map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        </Field>

        {(lists.data?.items.length ?? 0) > 0 ? (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] font-medium">Add to lists</legend>
            {(lists.data?.items ?? []).map((list) => (
              <label key={list.id} className="flex cursor-pointer items-center gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--foreground)]"
                  checked={settings.listIds.includes(list.id)}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      listIds: event.target.checked
                        ? [...settings.listIds, list.id]
                        : settings.listIds.filter((id) => id !== list.id),
                    })
                  }
                />
                {list.name}
              </label>
            ))}
            <span className="text-xs text-muted-foreground">
              A contact who unsubscribed from a list stays unsubscribed.
            </span>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap justify-between gap-3">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={!settings.consentBasis || pending}>
            Preview the import
          </Button>
        </div>
      </Panel>
    </form>
  );
}

// Preview, progress, and result ------------------------------------------------------------

const COUNT_TILES: ReadonlyArray<{ key: keyof Counts; label: string; color: string }> = [
  { key: "new", label: "New contacts", color: "bg-chart-2" },
  { key: "updated", label: "Updated", color: "bg-chart-3" },
  { key: "skippedUnsubscribed", label: "Skipped, unsubscribed", color: "bg-chart-1" },
  { key: "skippedSuppressed", label: "Skipped, suppressed", color: "bg-chart-1" },
  { key: "invalid", label: "Invalid rows", color: "bg-chart-4" },
  { key: "duplicate", label: "Duplicates in the file", color: "bg-chart-4" },
];

function CountGrid({ counts, label }: { counts: Counts; label: string }) {
  return (
    <section
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3"
      aria-label={label}
    >
      {COUNT_TILES.map((tile) => {
        const value = counts[tile.key];
        const share = counts.total > 0 ? Math.round((value / counts.total) * 100) : 0;
        return (
          <div
            key={tile.key}
            className="flex flex-col gap-2 bg-card p-[18px]"
            data-testid={`count-${tile.key}`}
          >
            <span className="text-xs text-muted-foreground">{tile.label}</span>
            <span className="text-[26px] leading-[1.1]">
              <Figure value={value} />
            </span>
            <div className="h-[3px] overflow-hidden rounded-full bg-track">
              <div
                className={`h-[3px] rounded-full ${tile.color}`}
                style={{ width: `${share}%` }}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Progress({ done, total, label }: { done: number; total: number | null; label: string }) {
  const share = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-[13px]">
        <span>{label}</span>
        <span className="text-muted-foreground">
          <Figure value={done} />
          {total !== null ? (
            <>
              {" "}
              of <Figure value={total} />
            </>
          ) : null}{" "}
          rows
        </span>
      </div>
      <div
        className="h-[3px] overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share ?? undefined}
      >
        <div
          className="h-[3px] rounded-full bg-chart-2 transition-[width]"
          style={{ width: `${share ?? 8}%` }}
        />
      </div>
    </div>
  );
}

function Summary({ item }: { item: Import }) {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 text-[13px]">
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">Consent basis</dt>
        <dd className="m-0">{item.consentBasis ? CONSENT[item.consentBasis].label : "-"}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">Tags</dt>
        <dd className="m-0 flex flex-wrap gap-1">
          {item.tags.length === 0
            ? "None"
            : item.tags.map((tag) => (
                <Pill key={tag} tone="lavender">
                  {tag}
                </Pill>
              ))}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">File</dt>
        <dd className="m-0 truncate">{item.filename}</dd>
      </div>
    </dl>
  );
}

function PreviewStep({ item, onChangeSettings }: { item: Import; onChangeSettings: () => void }) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const start = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/imports/{id}/start", { params: { path: { id: item.id } } })),
    onSuccess: (next) => queryClient.setQueryData(importQuery(current.id, item.id).queryKey, next),
  });

  if (item.status === "previewing" || !item.preview) {
    return (
      <Panel>
        <SectionHeader id="preview-title" title="Checking the file" />
        <Progress done={item.processedRows} total={null} label="Reading rows" />
        <p className="m-0 text-xs text-muted-foreground">
          Envelopen reads the file in chunks and compares it with your contacts and the suppression
          list. Nothing changes yet.
        </p>
      </Panel>
    );
  }

  const preview = item.preview;
  const importing = preview.new + preview.updated;
  const writes = item.estimatedRowWrites ?? 0;
  return (
    <Panel>
      <SectionHeader
        id="preview-title"
        title="Preview"
        aside={
          <>
            <Figure value={preview.total} /> rows in the file
          </>
        }
      />
      <CountGrid counts={preview} label="Preview counts" />
      <Summary item={item} />
      <p
        className={cn(
          "m-0 rounded-lg px-3 py-2 text-xs",
          writes > FREE_DAILY_WRITES * 0.8
            ? "bg-tone-salmon text-tone-salmon-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        This import writes about <Figure value={writes} /> D1 rows. Workers Free allows{" "}
        <Figure value={FREE_DAILY_WRITES} /> a day. If the limit is reached, the import waits until
        00:00 UTC and goes on.
      </p>
      <FormError message={errorText(start.error)} />
      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="outline" onClick={onChangeSettings}>
          Change settings
        </Button>
        <Button onClick={() => start.mutate()} pending={start.isPending} disabled={importing === 0}>
          <span>
            Import <Figure value={importing} /> {importing === 1 ? "contact" : "contacts"}
          </span>
        </Button>
      </div>
    </Panel>
  );
}

function ErrorFileButton({ item }: { item: Import }) {
  const download = useMutation({
    mutationFn: () =>
      unwrap(api.GET("/imports/{id}/error-file", { params: { path: { id: item.id } } })),
    onSuccess: (link) => window.location.assign(link.url),
  });
  return (
    <div className="flex flex-col gap-2">
      <FormError message={errorText(download.error)} />
      <div>
        <Button variant="outline" onClick={() => download.mutate()} pending={download.isPending}>
          <DownloadIcon className="size-3.5" aria-hidden="true" />
          <span>
            Download the error file (<Figure value={item.errorCount} /> rows)
          </span>
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        It lists each row that was not imported, with the reason. It is deleted{" "}
        {formatDateTime(item.expiresAt)}.
      </span>
    </div>
  );
}

function ImportStep({ item }: { item: Import }) {
  if (item.status === "importing") {
    return (
      <Panel>
        <SectionHeader id="progress-title" title="Importing" />
        <Progress done={item.processedRows} total={item.preview?.total ?? null} label="Imported" />
        <p className="m-0 text-xs text-muted-foreground">
          You can leave this page. The import goes on in the background.
        </p>
      </Panel>
    );
  }
  const counts = item.counts ?? item.preview;
  return (
    <Panel>
      <SectionHeader
        id="result-title"
        title="Import complete"
        aside={<>Finished {formatDateTime(item.completedAt)}</>}
      />
      {counts ? <CountGrid counts={counts} label="Import result" /> : null}
      <Summary item={item} />
      {item.hasErrorFile ? <ErrorFileButton item={item} /> : null}
      <p className="m-0 text-xs text-muted-foreground">
        The uploaded file is deleted. <Figure value={item.rowsWritten} /> D1 rows written.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/contacts">View contacts</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/contacts/import" search={{}}>
            Import another file
          </Link>
        </Button>
      </div>
    </Panel>
  );
}

// Page -------------------------------------------------------------------------------------

export function ImportPage({ importId }: { importId: number | undefined }) {
  const { current } = useCurrentWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<string[] | null>(null);
  const [settings, setSettings] = useState<Settings>({ consentBasis: null, tags: "", listIds: [] });
  const [editing, setEditing] = useState<"map" | "consent" | null>(null);

  const item = useQuery({
    ...importQuery(current.id, importId ?? 0),
    enabled: importId !== undefined,
    // Poll while a run is going.
    refetchInterval: (query) =>
      query.state.data?.status === "previewing" || query.state.data?.status === "importing"
        ? 1000
        : false,
  });

  const preview = useMutation({
    mutationFn: (input: { id: number; mapping: string[]; settings: Settings }) =>
      unwrap(
        api.POST("/imports/{id}/preview", {
          params: { path: { id: input.id } },
          body: {
            mapping: input.mapping,
            consentBasis: input.settings.consentBasis as ConsentBasis,
            tags: input.settings.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            listIds: input.settings.listIds,
          },
        }),
      ),
    onSuccess: (next) => {
      setEditing(null);
      queryClient.setQueryData(importQuery(current.id, next.id).queryKey, next);
    },
  });

  const data = importId === undefined ? null : (item.data ?? null);

  // When a run ends, the contacts, lists, tags, and the checklist change.
  const ended = data?.status === "completed" || data?.status === "failed";
  useEffect(() => {
    if (ended) {
      void queryClient.invalidateQueries({
        queryKey: ["ws", current.id],
        predicate: (query) => query.queryKey[2] !== "imports",
      });
    }
  }, [ended, queryClient, current.id]);
  const effectiveMapping =
    mapping ?? data?.mapping ?? upload?.suggestedMapping ?? data?.headers.map(() => "ignore") ?? [];

  let step: StepIndex = 0;
  let body: ReactNode;
  if (importId === undefined) {
    body = (
      <UploadStep
        onUploaded={(result) => {
          setUpload(result);
          setMapping(result.suggestedMapping);
          setSettings({ consentBasis: null, tags: "", listIds: [] });
          setEditing("map");
          queryClient.setQueryData(importQuery(current.id, result.id).queryKey, result);
          void navigate({ to: "/contacts/import", search: { id: result.id } });
        }}
      />
    );
  } else if (item.isError) {
    body = (
      <p role="alert" className="m-0 text-[13px] text-muted-foreground">
        {errorText(item.error)}
      </p>
    );
  } else if (!data) {
    body = <div className="h-48 rounded-xl border border-border bg-muted" />;
  } else if (data.status === "failed" || data.status === "expired") {
    body = (
      <Panel>
        <SectionHeader
          id="failed-title"
          title={data.status === "failed" ? "The import failed" : "The upload expired"}
        />
        <p className="m-0 text-[13px] text-muted-foreground">
          {data.failure ?? "The uploaded file was deleted after 24 hours."} Upload the file again to
          start over.
        </p>
        <div>
          <Button asChild variant="outline">
            <Link to="/contacts/import" search={{}}>
              Upload a file
            </Link>
          </Button>
        </div>
      </Panel>
    );
  } else if (
    data.status === "uploaded" ||
    (editing !== null && (data.status === "previewed" || data.status === "previewing"))
  ) {
    const atConsent = editing === "consent";
    step = atConsent ? 2 : 1;
    body = atConsent ? (
      <ConsentStep
        settings={settings}
        onChange={setSettings}
        onBack={() => setEditing("map")}
        pending={preview.isPending}
        error={preview.error}
        onPreview={() => preview.mutate({ id: data.id, mapping: effectiveMapping, settings })}
      />
    ) : (
      <MappingStep
        item={data}
        sample={upload?.id === data.id ? upload.sample : []}
        mapping={effectiveMapping}
        onChange={setMapping}
        onNext={() => setEditing("consent")}
      />
    );
  } else if (data.status === "previewing" || data.status === "previewed") {
    step = 3;
    body = (
      <PreviewStep
        item={data}
        onChangeSettings={() => {
          setSettings({
            consentBasis: data.consentBasis,
            tags: data.tags.join(", "),
            listIds: data.listIds,
          });
          setEditing("map");
        }}
      />
    );
  } else {
    step = data.status === "completed" ? 5 : 4;
    body = <ImportStep item={data} />;
  }

  return (
    <div className="flex max-w-[880px] flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Link
          to="/contacts"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Contacts
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
            Import contacts
          </h1>
          <p className="m-0 text-[15px] text-muted-foreground">
            Add or update contacts from a CSV. Unsubscribes and suppressions always stay.
          </p>
        </div>
      </div>
      <Stepper active={step} />
      {body}
    </div>
  );
}
