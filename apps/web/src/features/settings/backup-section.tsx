import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, ShieldAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, type Schemas, unwrap } from "@/api/client";
import { backupRunsQuery, backupStatusQuery, loginModeQuery, sessionQuery } from "@/api/queries";
import { AuthRequestError, signInWithPasskey, signInWithPassword } from "@/auth/auth-client";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill, type Tone } from "@/components/ui/pill";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { daysBetween, formatBytes, formatDateTime } from "@/lib/format";

// Backups (U4, U5, R1 to R4): the status, the passphrase, the daily schedule and the
// retention, the optional S3 copy, "Back up now", the run history, and the download of
// each backup. A restore that waits for the owner shows at the top.
//
// The passphrase, the S3 destination, "Back up now", and a download need a sign-in in
// the last 10 minutes. When the session is older, the server answers SESSION_NOT_FRESH,
// and the section asks for the password or the passkey, then repeats the action.

type BackupStatus = Schemas["BackupStatus"];
type BackupRun = NonNullable<Schemas["BackupRun"]>;

const MIN_PASSPHRASE = 12;
const MIN_RETENTION = 1;
const MAX_RETENTION = 365;

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function isNotFresh(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.details as { code?: string } | undefined)?.code === "SESSION_NOT_FRESH"
  );
}

const RUN_TONES: Record<BackupRun["status"], Tone> = {
  running: "neutral",
  succeeded: "teal",
  partial: "salmon",
  failed: "danger",
};
const RUN_LABELS: Record<BackupRun["status"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
};

function RunPill({ run }: { run: BackupRun }) {
  return (
    <Pill tone={RUN_TONES[run.status]}>
      {run.status === "running" ? <Spinner className="size-3" /> : null}
      {RUN_LABELS[run.status]}
    </Pill>
  );
}

// Sign in again ---------------------------------------------------------------------------------

/**
 * Runs an action that needs a recent sign-in. On SESSION_NOT_FRESH it opens the dialog,
 * and after the sign-in it runs the action again.
 */
function useFreshAction() {
  const [waiting, setWaiting] = useState<(() => void) | null>(null);
  const run = <T,>(
    action: () => Promise<T>,
    options: { onDone?: (value: T) => void; onError?: (error: unknown) => void } = {},
  ) => {
    const attempt = () => {
      action().then(options.onDone, (error: unknown) => {
        if (isNotFresh(error)) setWaiting(() => attempt);
        else options.onError?.(error);
      });
    };
    attempt();
  };
  const dialog = (
    <ReauthDialog
      open={waiting !== null}
      onClose={() => setWaiting(null)}
      onSignedIn={() => {
        const next = waiting;
        setWaiting(null);
        next?.();
      }}
    />
  );
  return { run, dialog };
}

function ReauthDialog({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery);
  const mode = useQuery(loginModeQuery);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passkey = mode.data === "passkey";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = session.data?.user.email;
    if (!email) return;
    setError(null);
    setPending(true);
    try {
      if (passkey) await signInWithPasskey();
      else await signInWithPassword(email, password);
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof AuthRequestError ? cause.message : "The sign-in did not work.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => (value ? null : onClose())}>
      <DialogContent>
        <DialogHeader
          title="Sign in again"
          description="Backups hold all data of this deployment. This action needs a sign-in from the last 10 minutes."
        />
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <FormError message={error} />
          {passkey ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              Your browser asks for the passkey of {session.data?.user.email}.
            </p>
          ) : (
            <Field id="reauth-password" label="Password">
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" pending={pending} disabled={!passkey && password === ""}>
              {passkey ? "Use the passkey" : "Sign in"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Parts --------------------------------------------------------------------------------------------

function Card({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13.5px] font-semibold">{title}</h3>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </div>
  );
}

function RestoreNotice({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const acknowledge = useMutation({
    mutationFn: () => unwrap(api.POST("/backups/restore/acknowledge")),
    onSuccess: (data) => queryClient.setQueryData(backupStatusQuery.queryKey, data),
  });
  const restore = status.restore;
  if (!restore) return null;
  const age = daysBetween(restore.backupCreatedAt, Date.now());
  return (
    <section
      aria-labelledby="restore-notice-title"
      className="flex flex-col gap-3 rounded-xl bg-tone-salmon p-5 text-tone-salmon-foreground"
    >
      <h3
        id="restore-notice-title"
        className="m-0 flex items-center gap-2 text-[13.5px] font-semibold"
      >
        <ShieldAlertIcon className="size-4" aria-hidden="true" />
        Campaign sends wait for you
      </h3>
      <p className="m-0 text-[13px]">
        This deployment was restored on {formatDateTime(restore.restoredAt)} from a backup of{" "}
        {formatDateTime(restore.backupCreatedAt)} ({age === 1 ? "1 day" : `${age} days`} before the
        restore). People who unsubscribed after the backup are not in it. Import the suppression and
        unsubscribe lists of your email provider first, then allow sends.
      </p>
      <FormError message={errorMessage(acknowledge.error)} />
      <div>
        <Button
          variant="outline"
          pending={acknowledge.isPending}
          onClick={() => acknowledge.mutate()}
        >
          I checked. Allow sends
        </Button>
      </div>
    </section>
  );
}

function StatusCard({ status }: { status: BackupStatus }) {
  const last = status.lastRun;
  const destinations = ["R2", ...(status.s3 ? [`S3 (${status.s3.bucket})`] : [])];
  return (
    <Card title="Status">
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Last successful backup</dt>
          <dd className="m-0">{formatDateTime(status.lastSuccess?.startedAt)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Last run</dt>
          <dd className="m-0 flex items-center gap-2">
            {last ? (
              <>
                {formatDateTime(last.startedAt)} <RunPill run={last} />
              </>
            ) : (
              "Never"
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Destinations</dt>
          <dd className="m-0">{destinations.join(" and ")}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Next daily backup</dt>
          <dd className="m-0">
            {status.nextRunAt
              ? formatDateTime(status.nextRunAt)
              : status.passphraseSet
                ? "Off"
                : "Set a passphrase first"}
          </dd>
        </div>
      </dl>
      {last && (last.status === "failed" || last.status === "partial") ? (
        <p className="m-0 rounded-lg bg-tone-danger px-3 py-2 text-[13px] text-tone-danger-foreground">
          {last.status === "partial"
            ? `The backup is in R2, but the S3 copy failed: ${last.s3Error ?? "unknown error"}`
            : `The backup failed: ${last.error ?? "unknown error"}`}
        </p>
      ) : null}
    </Card>
  );
}

function PassphraseCard({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const { run, dialog } = useFreshAction();
  const [open, setOpen] = useState(!status.passphraseSet);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const derivation = status.passphraseDerivation;
  const deriving = derivation?.status === "pending";

  const lengthError =
    touched && passphrase.length < MIN_PASSPHRASE
      ? `Use at least ${MIN_PASSPHRASE} characters.`
      : null;
  const matchError = touched && confirm !== passphrase ? "The two passphrases differ." : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (passphrase.length < MIN_PASSPHRASE || confirm !== passphrase) return;
    setError(null);
    setPending(true);
    run(() => unwrap(api.POST("/backups/passphrase", { body: { passphrase } })), {
      onDone: (data) => {
        setPending(false);
        setPassphrase("");
        setConfirm("");
        setTouched(false);
        setOpen(false);
        queryClient.setQueryData(backupStatusQuery.queryKey, data);
      },
      onError: (cause) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    });
  }

  return (
    <Card
      title="Passphrase"
      aside={
        status.passphraseSet
          ? `Set on ${formatDateTime(status.keySetAt)}`
          : "No passphrase yet. Backups are off."
      }
    >
      <p className="m-0 flex gap-2 rounded-lg bg-tone-lavender px-3 py-2.5 text-[13px] text-tone-lavender-foreground">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          The passphrase encrypts every backup. Envelopen keeps only a public key, so nobody can
          recover a lost passphrase, and a backup without it cannot be restored. Store it in a
          password manager. After a change, older backups still need the old passphrase.
        </span>
      </p>
      {deriving ? (
        <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Preparing the backup key from the passphrase. This takes a few seconds.
        </p>
      ) : derivation?.status === "failed" ? (
        <p role="alert" className="m-0 text-[13px] text-tone-danger-foreground">
          The key preparation failed: {derivation.error ?? "unknown error"}. Set the passphrase
          again.
        </p>
      ) : null}
      {open ? (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <FormError message={error} />
          <div className="grid max-w-[640px] grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="backup-passphrase"
              label={status.passphraseSet ? "New passphrase" : "Passphrase"}
              hint={`At least ${MIN_PASSPHRASE} characters.`}
              error={lengthError}
            >
              <Input
                id="backup-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                aria-invalid={lengthError ? true : undefined}
                aria-describedby="backup-passphrase-hint"
              />
            </Field>
            <Field id="backup-passphrase-confirm" label="Repeat the passphrase" error={matchError}>
              <Input
                id="backup-passphrase-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                aria-invalid={matchError ? true : undefined}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              {status.passphraseSet ? "Change the passphrase" : "Set the passphrase"}
            </Button>
            {status.passphraseSet ? (
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Change the passphrase
          </Button>
        </div>
      )}
      {dialog}
    </Card>
  );
}

function ScheduleCard({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const { run, dialog } = useFreshAction();
  const [enabled, setEnabled] = useState(status.enabled);
  const [days, setDays] = useState(String(status.retentionDays));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const value = Number(days);
  const daysError =
    !Number.isInteger(value) || value < MIN_RETENTION || value > MAX_RETENTION
      ? `Enter a whole number from ${MIN_RETENTION} to ${MAX_RETENTION}.`
      : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (daysError) return;
    setError(null);
    setPending(true);
    run(() => unwrap(api.PATCH("/backups/settings", { body: { enabled, retentionDays: value } })), {
      onDone: (data) => {
        setPending(false);
        setSaved(true);
        queryClient.setQueryData(backupStatusQuery.queryKey, data);
      },
      onError: (cause) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    });
  }

  return (
    <Card title="Schedule and retention">
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <div className="flex items-start gap-2.5">
          <Checkbox
            id="backup-enabled"
            checked={enabled}
            onCheckedChange={(checked) => {
              setSaved(false);
              setEnabled(checked === true);
            }}
            aria-describedby="backup-enabled-hint"
          />
          <div className="flex flex-col">
            <Label htmlFor="backup-enabled" className="cursor-pointer font-normal">
              Back up every day
            </Label>
            <span id="backup-enabled-hint" className="text-xs text-muted-foreground">
              At 02:23 UTC, within a daily D1 read budget of {status.readBudget.toLocaleString()}{" "}
              rows.
            </span>
          </div>
        </div>
        <Field
          id="backup-retention"
          label="Keep backups for (days)"
          hint="The newest backup always stays."
          error={daysError}
          className="max-w-[260px]"
        >
          <Input
            id="backup-retention"
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION}
            max={MAX_RETENTION}
            value={days}
            onChange={(event) => {
              setSaved(false);
              setDays(event.target.value);
            }}
            aria-invalid={daysError ? true : undefined}
            aria-describedby="backup-retention-hint"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" pending={pending} disabled={daysError !== null}>
            Save the schedule
          </Button>
          {saved ? (
            <span role="status" className="motion-enter text-[13px] text-muted-foreground">
              Saved.
            </span>
          ) : null}
        </div>
      </form>
      {dialog}
    </Card>
  );
}

const S3_FIELDS = [
  ["endpoint", "Endpoint", "For example https://s3.eu-central-1.amazonaws.com.", "url"],
  ["region", "Region", "For example us-east-1, or auto for R2.", "text"],
  ["bucket", "Bucket", "The bucket that gets a copy of each backup.", "text"],
  ["accessKeyId", "Access key id", null, "text"],
  ["secretAccessKey", "Secret access key", "Stored encrypted. It never shows again.", "password"],
] as const;

type S3Draft = Record<(typeof S3_FIELDS)[number][0], string>;

function S3Card({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const { run, dialog } = useFreshAction();
  const [open, setOpen] = useState(false);
  const empty: S3Draft = {
    endpoint: status.s3?.endpoint ?? "",
    region: status.s3?.region ?? "",
    bucket: status.s3?.bucket ?? "",
    accessKeyId: status.s3?.accessKeyId ?? "",
    secretAccessKey: "",
  };
  const [draft, setDraft] = useState<S3Draft>(empty);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "remove" | null>(null);

  function save(s3: S3Draft | null) {
    setError(null);
    setPending(s3 ? "save" : "remove");
    run(() => unwrap(api.PATCH("/backups/settings", { body: { s3 } })), {
      onDone: (data) => {
        setPending(null);
        setOpen(false);
        setDraft({ ...draft, secretAccessKey: "" });
        queryClient.setQueryData(backupStatusQuery.queryKey, data);
      },
      onError: (cause) => {
        setPending(null);
        if (cause instanceof ApiRequestError && Array.isArray(cause.details)) {
          const first = cause.details[0] as { message?: string } | undefined;
          setError(first?.message ?? cause.message);
        } else {
          setError(errorMessage(cause));
        }
      },
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(draft);
  }

  const complete = S3_FIELDS.every(([key]) => draft[key].trim() !== "");

  return (
    <Card
      title="Copy to S3"
      aside={status.s3 ? `${status.s3.bucket} at ${new URL(status.s3.endpoint).host}` : "Optional"}
    >
      <p className="m-0 text-[13px] text-muted-foreground">
        Each backup goes to R2. An S3-compatible store, such as AWS S3, Backblaze B2, or another R2
        account, can get a copy too. Retention removes old copies there as well.
      </p>
      {open ? (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <FormError message={error} />
          <div className="grid max-w-[640px] grid-cols-1 gap-4 sm:grid-cols-2">
            {S3_FIELDS.map(([key, label, hint, type]) => (
              <Field key={key} id={`s3-${key}`} label={label} hint={hint ?? undefined}>
                <Input
                  id={`s3-${key}`}
                  type={type}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft[key]}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  aria-describedby={hint ? `s3-${key}-hint` : undefined}
                />
              </Field>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending === "save"} disabled={!complete}>
              Save the destination
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen(true)}>
            {status.s3 ? "Change the destination" : "Add a destination"}
          </Button>
          {status.s3 ? (
            <Button
              variant="destructive-ghost"
              pending={pending === "remove"}
              onClick={() => save(null)}
            >
              Remove
            </Button>
          ) : null}
          <FormError message={open ? null : error} />
        </div>
      )}
      {dialog}
    </Card>
  );
}

function RunsCard({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const runs = useQuery({
    ...backupRunsQuery,
    // While a run is running, the list follows it.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item?.status === "running") ? 3_000 : false,
  });
  const { run, dialog } = useFreshAction();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const items = (runs.data?.items ?? []).filter((item): item is BackupRun => item !== null);
  const running = items.some((item) => item.status === "running");
  const previous = useRef(running);

  useEffect(() => {
    // A run ended: the status card shows the new last run.
    if (previous.current && !running) {
      void queryClient.invalidateQueries({ queryKey: backupStatusQuery.queryKey });
    }
    previous.current = running;
  }, [running, queryClient]);

  function backUpNow() {
    setError(null);
    setStarting(true);
    run(() => unwrap(api.POST("/backups/runs")), {
      onDone: async () => {
        setStarting(false);
        await queryClient.invalidateQueries({ queryKey: ["backups"] });
      },
      onError: (cause) => {
        setStarting(false);
        setError(errorMessage(cause));
      },
    });
  }

  function download(item: BackupRun) {
    setError(null);
    setDownloading(item.id);
    run(
      () => unwrap(api.POST("/backups/runs/{id}/download", { params: { path: { id: item.id } } })),
      {
        onDone: (link) => {
          setDownloading(null);
          const anchor = document.createElement("a");
          anchor.href = link.url;
          anchor.download = link.filename;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        },
        onError: (cause) => {
          setDownloading(null);
          setError(errorMessage(cause));
        },
      },
    );
  }

  return (
    <Card
      title="Backups"
      aside={
        <Button
          size="sm"
          onClick={backUpNow}
          pending={starting}
          disabled={!status.passphraseSet || running}
        >
          Back up now
        </Button>
      }
    >
      <FormError message={error} />
      {runs.isPending ? (
        <LoadingRegion label="Loading the backups" className="flex flex-col gap-2">
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
        </LoadingRegion>
      ) : items.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          {status.passphraseSet
            ? "No backup yet. The first one runs tonight, or now with Back up now."
            : "Set a passphrase to start backing up."}
        </p>
      ) : (
        <Table aria-label="Backups">
          <thead>
            <tr>
              <TableHead>Started</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>
                <span className="sr-only">Download</span>
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const kept =
                (item.status === "succeeded" || item.status === "partial") && !item.deletedAt;
              return (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(item.startedAt)}
                    <span className="block text-xs text-muted-foreground">
                      {item.trigger === "manual" ? "Manual" : "Daily"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <RunPill run={item} />
                    {item.error || item.s3Error ? (
                      <span className="mt-1 block max-w-[260px] text-xs text-muted-foreground">
                        {item.error ?? `S3: ${item.s3Error}`}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="figure">{item.rowCount.toLocaleString()}</TableCell>
                  <TableCell className="figure whitespace-nowrap">
                    {formatBytes(item.sizeBytes)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.deletedAt
                      ? "Removed"
                      : item.destinations.map((d) => d.toUpperCase()).join(", ") || "None"}
                  </TableCell>
                  <TableCell className="text-right">
                    {kept ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        pending={downloading === item.id}
                        onClick={() => download(item)}
                        aria-label={`Download the backup of ${formatDateTime(item.startedAt)}`}
                      >
                        <DownloadIcon className="size-3.5" aria-hidden="true" />
                        Download
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </tbody>
        </Table>
      )}
      <p className="m-0 text-xs text-muted-foreground">
        A download is one encrypted .envbak file. The first-run screen of a new deployment restores
        it with the passphrase.
      </p>
      {dialog}
    </Card>
  );
}

// The section ------------------------------------------------------------------------------------

export function BackupSection() {
  const query = useQuery({
    ...backupStatusQuery,
    // While the passphrase key is prepared, the status follows it.
    refetchInterval: (state) =>
      state.state.data?.passphraseDerivation?.status === "pending" ? 2_000 : 5 * 60_000,
  });
  const status = query.data;

  return (
    <section
      id="backups"
      aria-labelledby="backups-title"
      className="flex scroll-mt-6 flex-col gap-4"
    >
      <SectionHeader id="backups-title" title="Backups" aside="Applies to the whole deployment." />
      {query.isError ? (
        <FormError message={errorMessage(query.error)} />
      ) : !status ? (
        <LoadingRegion
          label="Loading the backup settings"
          className="flex flex-col gap-4 rounded-xl border border-border p-5"
        >
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-16 rounded-lg" />
        </LoadingRegion>
      ) : (
        <div className="flex flex-col gap-4">
          <RestoreNotice status={status} />
          <StatusCard status={status} />
          <PassphraseCard key={String(status.keySetAt)} status={status} />
          <RunsCard status={status} />
          <ScheduleCard status={status} />
          <S3Card key={status.s3?.bucket ?? "none"} status={status} />
        </div>
      )}
    </section>
  );
}
