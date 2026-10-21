import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import {
  AuthRequestError,
  type BackupSummary,
  type RestoreSourceInput,
  type RestoreStatus,
  restoreSources,
  restoreStart,
  restoreStatus,
  restoreUpload,
} from "@/auth/auth-client";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes, formatDateTime } from "@/lib/format";

// Restore from the first-run screen (U5, KTD3). The owner picks a backup in this
// deployment's R2 bucket or a backup file, enters the passphrase, and follows the
// progress. The progress lives on the server, so a reload shows it again after the
// setup token.

const MIN_PASSPHRASE = 12;
const POLL_MS = 2_000;

function messageOf(error: unknown): string {
  if (error instanceof AuthRequestError) return error.message;
  return "Something went wrong. Try again.";
}

/** "campaign_stats_daily" as "Campaign stats daily". */
function tableLabel(table: string): string {
  const text = table.replace(/^auth_/, "sign-in ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function n(value: number): string {
  return value.toLocaleString();
}

function days(count: number): string {
  return count === 1 ? "1 day" : `${n(count)} days`;
}

function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-tone-neutral"
    >
      <div
        className="h-full rounded-full bg-tone-teal-foreground/70 transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// Choosing the source ---------------------------------------------------------------------------

function SourceForm({
  token,
  onStarted,
  onBack,
  failure,
}: {
  token: string;
  onStarted: (status: RestoreStatus) => void;
  onBack: () => void;
  failure: RestoreStatus | null;
}) {
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const [maxUpload, setMaxUpload] = useState(0);
  const [kind, setKind] = useState<"r2" | "upload">("upload");
  const [backupId, setBackupId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"upload" | "start" | null>(null);

  useEffect(() => {
    let live = true;
    restoreSources(token)
      .then((result) => {
        if (!live) return;
        setBackups(result.backups);
        setMaxUpload(result.maxUploadBytes);
        const first = result.backups.find((backup) => backup.problem === null);
        if (first) {
          setKind("r2");
          setBackupId(first.backupId);
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [token]);

  const chosen = backups?.find((backup) => backup.backupId === backupId) ?? null;
  const passphraseError =
    passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE
      ? `The passphrase has at least ${MIN_PASSPHRASE} characters.`
      : null;
  const ready =
    passphrase.length >= MIN_PASSPHRASE && (kind === "r2" ? chosen !== null : file !== null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      let source: RestoreSourceInput;
      if (kind === "upload") {
        if (!file) return;
        if (maxUpload > 0 && file.size > maxUpload) {
          setError(
            `The file is ${formatBytes(file.size)}. One upload takes at most ${formatBytes(maxUpload)}. Copy the backup folder into the R2 bucket of this deployment instead.`,
          );
          return;
        }
        setPending("upload");
        const uploaded = await restoreUpload(token, file);
        if (uploaded.backup.problem) {
          setError(uploaded.backup.problem);
          return;
        }
        source = { kind: "upload", uploadId: uploaded.uploadId };
      } else {
        source = { kind: "r2", backupId };
      }
      setPending("start");
      const started = await restoreStart({ token, source, passphrase });
      setPassphrase("");
      onStarted(started.restore);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <AuthLayout
      wide
      title="Restore a backup"
      description="Bring the data of an Envelopen backup into this new deployment. Restore works only before an owner exists."
    >
      <form className="flex flex-col gap-5" onSubmit={(event) => void onSubmit(event)} noValidate>
        {failure ? (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-lg bg-tone-danger px-3 py-2.5 text-[13px] text-tone-danger-foreground"
          >
            <span className="font-medium">The last restore stopped.</span>
            <span>
              {failure.failedStep ? `Step: ${failure.failedStep}. ` : ""}
              {failure.error ?? "Try again."}
            </span>
            {failure.chunksDone > 0 ? (
              <span>
                Start the same backup again to go on from chunk {n(failure.chunksDone + 1)} of{" "}
                {n(failure.chunkCount)}.
              </span>
            ) : null}
          </div>
        ) : null}
        <FormError message={error} />

        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 text-[13px] font-medium">Backup</legend>
          <RadioGroup
            value={kind}
            onValueChange={(value) => setKind(value as "r2" | "upload")}
            aria-label="Where the backup is"
          >
            <div className="flex items-start gap-2.5">
              <RadioGroupItem id="source-upload" value="upload" />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="source-upload" className="cursor-pointer font-normal">
                  Upload a file
                </Label>
                <span className="text-xs text-muted-foreground">
                  The .envbak file that you downloaded from Settings of the old deployment.
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <RadioGroupItem
                id="source-r2"
                value="r2"
                disabled={!backups || backups.length === 0}
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="source-r2" className="cursor-pointer font-normal">
                  A backup in this deployment's R2 bucket
                </Label>
                <span className="text-xs text-muted-foreground">
                  {backups === null
                    ? "Looking for backups."
                    : backups.length === 0
                      ? "The bucket holds no backup."
                      : `${n(backups.length)} found. Useful when you deploy again into the same Cloudflare account.`}
                </span>
              </div>
            </div>
          </RadioGroup>
        </fieldset>

        {kind === "upload" ? (
          <Field
            id="restore-file"
            label="Backup file"
            hint={maxUpload > 0 ? `At most ${formatBytes(maxUpload)} in one upload.` : undefined}
          >
            <Input
              id="restore-file"
              type="file"
              accept=".envbak,application/octet-stream"
              aria-describedby="restore-file-hint"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </Field>
        ) : (
          <RadioGroup
            value={backupId}
            onValueChange={setBackupId}
            aria-label="Backups in R2"
            className="gap-0 rounded-xl border border-border px-4 py-1"
          >
            {(backups ?? []).map((backup) => (
              <div
                key={backup.backupId}
                className="flex items-start gap-2.5 border-b border-hairline py-2.5 last:border-b-0"
              >
                <RadioGroupItem
                  id={`backup-${backup.backupId}`}
                  value={backup.backupId}
                  disabled={backup.problem !== null}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Label
                    htmlFor={`backup-${backup.backupId}`}
                    className="cursor-pointer font-normal"
                  >
                    {formatDateTime(backup.createdAt)}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {n(backup.totalRows)} rows · {formatBytes(backup.sizeBytes)} · about{" "}
                    {days(backup.estimatedDays)} on Workers Free
                  </span>
                  {backup.problem ? (
                    <span className="text-xs text-tone-danger-foreground">{backup.problem}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </RadioGroup>
        )}

        <Field
          id="restore-passphrase"
          label="Backup passphrase"
          hint="The passphrase that the old deployment set in Settings. Envelopen cannot recover it."
          error={passphraseError}
        >
          <Input
            id="restore-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            aria-invalid={passphraseError ? true : undefined}
            aria-describedby={
              passphraseError
                ? "restore-passphrase-hint restore-passphrase-error"
                : "restore-passphrase-hint"
            }
          />
        </Field>

        <p className="m-0 text-[13px] text-muted-foreground">
          On Workers Free, D1 takes 100,000 written rows per day. A large restore pauses at the
          limit and goes on after 00:00 UTC
          {kind === "r2" && chosen
            ? `. This backup needs about ${days(chosen.estimatedDays)}.`
            : "."}{" "}
          Workers Paid has no daily limit.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={pending !== null}>
            Back
          </Button>
          <Button type="submit" pending={pending !== null} disabled={!ready}>
            {pending === "upload"
              ? "Uploading the file"
              : pending === "start"
                ? "Starting"
                : "Start the restore"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

// Progress -------------------------------------------------------------------------------------

function statusLine(status: RestoreStatus): string {
  switch (status.status) {
    case "deriving":
      return "Checking the passphrase. This takes a few seconds.";
    case "running":
      return `Restoring chunk ${n(Math.min(status.chunksDone + 1, status.chunkCount))} of ${n(status.chunkCount)}.`;
    case "waiting":
      return `D1 reached today's write budget. The restore goes on at ${formatDateTime(status.resumeAt)}.`;
    case "succeeded":
      return "The restore is complete.";
    default:
      return "The restore stopped.";
  }
}

function Progress({ status }: { status: RestoreStatus }) {
  const done = status.rowsInserted + status.rowsSkipped;
  const active = status.status !== "succeeded" && status.status !== "failed";
  return (
    <section aria-labelledby="restore-progress-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="restore-progress-title"
            className="m-0 text-[15px] font-semibold tracking-[-0.01em]"
          >
            Progress
          </h2>
          {status.status === "succeeded" ? (
            <Pill tone="teal">Complete</Pill>
          ) : status.status === "failed" ? (
            <Pill tone="danger">Stopped</Pill>
          ) : status.status === "waiting" ? (
            <Pill tone="lavender">Waiting for the reset</Pill>
          ) : (
            <Pill tone="neutral">
              <Spinner className="size-3" />
              Running
            </Pill>
          )}
        </div>
        <p role="status" aria-live="polite" className="m-0 text-[13px] text-muted-foreground">
          {statusLine(status)}
        </p>
        <ProgressBar value={done} max={status.totalRows} label="Rows restored" />
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Rows</dt>
            <dd className="m-0 figure">
              {n(done)} of {n(status.totalRows)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Skipped orphans</dt>
            <dd className="m-0 figure">{n(status.rowsSkipped)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Estimate on Free</dt>
            <dd className="m-0 figure">{days(status.estimatedDays)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {active ? "Time left" : "Backup from"}
            </dt>
            <dd className="m-0 figure">
              {active
                ? `About ${days(status.remainingDays)}`
                : formatDateTime(status.backupCreatedAt)}
            </dd>
          </div>
        </dl>
      </div>
      <ul
        aria-label="Progress by table"
        className="m-0 flex list-none flex-col rounded-xl border border-border px-4 py-1"
      >
        {status.tables
          .filter((table) => table.totalRows > 0)
          .map((table) => (
            <li
              key={table.table}
              className="flex flex-col gap-1.5 border-b border-hairline py-2.5 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span>{tableLabel(table.table)}</span>
                <span className="figure text-xs text-muted-foreground">
                  {n(table.rowsDone)} of {n(table.totalRows)}
                  {table.rowsSkipped > 0 ? ` · ${n(table.rowsSkipped)} skipped` : ""}
                </span>
              </div>
              <ProgressBar
                value={table.rowsDone + table.rowsSkipped}
                max={table.totalRows}
                label={`${tableLabel(table.table)} restored`}
              />
            </li>
          ))}
      </ul>
    </section>
  );
}

function ProgressView({
  token,
  initial,
  onRetry,
}: {
  token: string;
  initial: RestoreStatus;
  onRetry: (failed: RestoreStatus) => void;
}) {
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const active = status.status !== "succeeded" && status.status !== "failed";

  useEffect(() => {
    if (!active) return;
    let live = true;
    const timer = window.setInterval(() => {
      restoreStatus(token)
        .then((result) => {
          if (!live) return;
          setError(null);
          if (result.restore) setStatus(result.restore);
        })
        .catch((cause: unknown) => {
          if (live) setError(messageOf(cause));
        });
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [token, active]);

  if (status.status === "succeeded") {
    return (
      <AuthLayout
        wide
        title="Restore complete"
        description={`Envelopen restored the backup from ${formatDateTime(status.backupCreatedAt)}.`}
      >
        <Progress status={status} />
        <div className="flex flex-col gap-2 rounded-xl bg-tone-neutral px-4 py-3 text-[13px] text-tone-neutral-foreground">
          <p className="m-0">
            Sign in again: no session moved with the backup. A passkey works only on the same
            hostname. On a new hostname, sign in with the password.
          </p>
          <p className="m-0">
            Campaign sends stay off until you confirm the age of the backup. First import the
            suppression and unsubscribe lists of your email provider, because unsubscribes after the
            backup are not in it.
          </p>
          {status.rowsSkipped > 0 ? (
            <p className="m-0">
              {n(status.rowsSkipped)} rows pointed at rows that changed during the backup. The
              restore left them out.
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button asChild>
            <Link to="/login">Go to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (status.status === "failed") {
    const wrong = status.errorCode === "wrong_passphrase";
    return (
      <AuthLayout
        wide
        title={wrong ? "The passphrase is not correct" : "The restore stopped"}
        description={
          wrong
            ? "Nothing was written. Check the passphrase of the backup, then try again."
            : "The rows that went in stay. Start the restore of the same backup again to go on."
        }
      >
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg bg-tone-danger px-3 py-2.5 text-[13px] text-tone-danger-foreground"
        >
          {status.failedStep ? (
            <span className="font-medium">Step: {status.failedStep}</span>
          ) : null}
          <span>{status.error ?? "Try again."}</span>
        </div>
        {wrong ? null : <Progress status={status} />}
        <div className="flex justify-end">
          <Button onClick={() => onRetry(status)}>Try again</Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      wide
      title="Restoring the backup"
      description="You can close this page. The restore goes on, and the setup token shows the progress again."
    >
      <FormError message={error} />
      <Progress status={status} />
    </AuthLayout>
  );
}

// The flow ------------------------------------------------------------------------------------

/**
 * The restore part of the first-run screen. `initial` is the newest restore, when one
 * exists: a reload then goes straight to its progress.
 */
export function RestoreFlow({
  token,
  initial,
  onBack,
}: {
  token: string;
  initial: RestoreStatus | null;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<RestoreStatus | null>(
    initial && initial.status !== "failed" ? initial : null,
  );
  const [failure, setFailure] = useState<RestoreStatus | null>(
    initial?.status === "failed" ? initial : null,
  );

  if (status) {
    return (
      <ProgressView
        key={status.id}
        token={token}
        initial={status}
        onRetry={(failed) => {
          setFailure(failed);
          setStatus(null);
        }}
      />
    );
  }
  return (
    <SourceForm
      token={token}
      failure={failure}
      onBack={onBack}
      onStarted={(started) => {
        setFailure(null);
        setStatus(started);
      }}
    />
  );
}
