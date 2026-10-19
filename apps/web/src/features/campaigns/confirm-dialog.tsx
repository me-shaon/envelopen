import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  RefreshCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ApiRequestError, api, type Schemas, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, Figure } from "@/features/contacts/shared";
import { cn } from "@/lib/utils";
import { EXCLUSION_LABELS, formatWhen, toLocalInput } from "./shared";

// The send confirmation (R33, R68). Step one picks the mode. Prepare then runs the
// checklist and returns a short-lived token; Confirm spends it. States:
// - blocked: a check failed. Each failed item links to the page that fixes it.
// - ready: the checklist, the estimated recipients, the provider, and the mode.
// - expired: the token ran out. Prepare again.
// - stale: the campaign changed after prepare. Review it and prepare again.

type Prepared = Schemas["CampaignPrepare"];
type Mode = Prepared["mode"];
type Item = Schemas["ChecklistItem"];

const ICONS: Record<Item["status"], { icon: typeof CheckIcon; className: string; label: string }> =
  {
    pass: { icon: CheckIcon, className: "bg-tone-teal text-tone-teal-foreground", label: "Passed" },
    warn: {
      icon: AlertTriangleIcon,
      className: "bg-tone-salmon text-tone-salmon-foreground",
      label: "Warning",
    },
    fail: { icon: XIcon, className: "bg-tone-danger text-tone-danger-foreground", label: "Failed" },
  };

function ChecklistRow({ item, onNavigate }: { item: Item; onNavigate: () => void }) {
  const look = ICONS[item.status];
  const Icon = look.icon;
  return (
    <li
      className="flex items-start gap-3 py-2"
      data-testid="checklist-item"
      data-status={item.status}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full",
          look.className,
        )}
      >
        <Icon className="size-3" strokeWidth={2.6} aria-label={look.label} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium">{item.label}</span>
        <span className="text-xs break-words text-muted-foreground">{item.message}</span>
      </div>
      {item.fix && item.status !== "pass" ? (
        <Link
          to={item.fix.path as "/"}
          onClick={onNavigate}
          className="shrink-0 text-xs font-medium underline"
        >
          {item.fix.label}
        </Link>
      ) : null}
    </li>
  );
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl bg-tone-salmon px-4 py-3 text-tone-salmon-foreground"
    >
      {icon}
      <div className="flex flex-col gap-0.5 text-[13px]">
        <span className="font-semibold">{title}</span>
        <span>{children}</span>
      </div>
    </div>
  );
}

function reasonOf(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : null;
}

export function ConfirmSendDialog({
  campaign,
  open,
  onOpenChange,
}: {
  campaign: Schemas["Campaign"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("send_now");
  const [when, setWhen] = useState(() => toLocalInput(Date.now() + 60 * 60 * 1000));
  const [now, setNow] = useState(() => Date.now());

  const prepare = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/campaigns/{id}/prepare", {
          params: { path: { id: campaign.id } },
          body: { mode, ...(mode === "schedule" ? { scheduledAt: new Date(when).getTime() } : {}) },
        }),
      ),
  });
  const confirm = useMutation({
    mutationFn: (token: string) =>
      unwrap(
        api.POST("/campaigns/{id}/confirm", {
          params: { path: { id: campaign.id } },
          body: { token },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      onOpenChange(false);
    },
  });

  // The expired state shows without a click once the token's time is over.
  const expiresAt = prepare.data?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const reset = () => {
    prepare.reset();
    confirm.reset();
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const prepared = prepare.data;
  const reason = reasonOf(confirm.error);
  const expired =
    reason === "expired" || reason === "used" || (expiresAt !== null && now >= expiresAt);
  const stale = reason === "stale";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[560px] overflow-y-auto">
        <DialogHeader
          title={prepared ? "Confirm the send" : "Send the campaign"}
          description={
            prepared
              ? "Check the list below. Nothing is sent until you confirm."
              : "Envelopen checks the campaign before it asks you to confirm."
          }
        />
        {!prepared ? (
          <PickMode
            mode={mode}
            onMode={setMode}
            when={when}
            onWhen={setWhen}
            error={errorText(prepare.error)}
          />
        ) : (
          <Review prepared={prepared} onNavigate={() => close(false)} />
        )}

        {prepared && stale ? (
          <Notice
            icon={<RefreshCwIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            title="The campaign changed"
          >
            It was edited after you started this check. Review it, then check again.
          </Notice>
        ) : prepared && expired ? (
          <Notice
            icon={<ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            title="This confirmation expired"
          >
            For safety, a confirmation works for 15 minutes and once only. Check again to continue.
          </Notice>
        ) : prepared?.blocked ? (
          <Notice
            icon={<XIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            title="Fix the failed checks first"
          >
            Each failed check links to the page that fixes it.
          </Notice>
        ) : null}
        {!stale && !expired ? <FormError message={errorText(confirm.error)} /> : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {!prepared ? (
            <Button type="button" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
              {prepare.isPending ? "Checking..." : "Check and continue"}
            </Button>
          ) : stale || expired || prepared.blocked ? (
            <Button type="button" onClick={reset}>
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Check again
            </Button>
          ) : (
            <Button
              type="button"
              disabled={confirm.isPending || !prepared.token}
              onClick={() => prepared.token && confirm.mutate(prepared.token)}
            >
              <SendIcon className="size-3.5" aria-hidden="true" />
              {confirm.isPending
                ? "Confirming..."
                : prepared.mode === "schedule"
                  ? `Schedule for ${formatWhen(prepared.scheduledAt)}`
                  : `Send to about ${prepared.estimate.recipients.toLocaleString()} people`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickMode({
  mode,
  onMode,
  when,
  onWhen,
  error,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  when: string;
  onWhen: (value: string) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormError message={error} />
      <RadioGroup
        value={mode}
        onValueChange={(value) => onMode(value as Mode)}
        aria-label="When to send"
      >
        <div className="flex items-start gap-2.5">
          <RadioGroupItem value="send_now" id="send-mode-now" />
          <Label htmlFor="send-mode-now" className="cursor-pointer font-normal">
            Send now
          </Label>
        </div>
        <div className="flex items-start gap-2.5">
          <RadioGroupItem value="schedule" id="send-mode-schedule" />
          <Label htmlFor="send-mode-schedule" className="cursor-pointer font-normal">
            Schedule for later
          </Label>
        </div>
      </RadioGroup>
      {mode === "schedule" ? (
        <Field id="send-at" label="Send at" hint="Your local time.">
          <Input
            id="send-at"
            type="datetime-local"
            value={when}
            onChange={(event) => onWhen(event.target.value)}
          />
        </Field>
      ) : null}
    </div>
  );
}

function Review({ prepared, onNavigate }: { prepared: Prepared; onNavigate: () => void }) {
  const excluded = Object.entries(prepared.estimate.excluded).filter(([, count]) => count > 0) as [
    keyof typeof EXCLUSION_LABELS,
    number,
  ][];
  return (
    <div className="flex flex-col gap-5">
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] overflow-hidden rounded-xl border border-border">
        <div className="flex flex-col gap-1 p-4">
          <dt className="text-xs text-muted-foreground">Recipients (estimate)</dt>
          <dd className="m-0 text-[22px] leading-none" data-testid="estimate">
            <Figure value={prepared.estimate.recipients} />
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-l border-border p-4">
          <dt className="text-xs text-muted-foreground">Provider</dt>
          <dd className="m-0 truncate text-[13px] font-medium">
            {prepared.provider ? `${prepared.provider.providerName}` : "None"}
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-l border-border p-4">
          <dt className="text-xs text-muted-foreground">Mode</dt>
          <dd className="m-0 text-[13px] font-medium">
            {prepared.mode === "schedule"
              ? `Scheduled, ${formatWhen(prepared.scheduledAt)}`
              : "Send now"}
          </dd>
        </div>
      </dl>
      <p className="m-0 text-xs text-muted-foreground">
        The count is an estimate. Envelopen takes the final list when the send starts, and checks
        each contact again just before its email goes out.
      </p>
      {excluded.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Left out</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {excluded.map(([reason, count]) => (
              <li key={reason} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Pill>
                  <Figure value={count} />
                </Pill>
                {EXCLUSION_LABELS[reason]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul
        className="m-0 flex list-none flex-col divide-y divide-hairline p-0"
        aria-label="Checklist"
      >
        {prepared.checklist.map((item) => (
          <ChecklistRow key={item.id} item={item} onNavigate={onNavigate} />
        ))}
      </ul>
    </div>
  );
}
