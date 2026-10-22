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
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
import { ambiguityNote, instantToWallTime, wallTimeToInstant } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { EXCLUSION_LABELS, formatDay, formatScheduled } from "./shared";
import { rememberedTimeZone, rememberTimeZone, TimeZonePicker } from "./timezone-picker";

// The send confirmation (R33, R68). Step one picks the mode. Prepare then runs the
// checklist and returns a short-lived token; Confirm spends it. States:
// - blocked: a check failed. Each failed item links to the page that fixes it.
// - ready: the checklist, the estimated recipients, the provider, and the mode.
// - expired: the token ran out. Prepare again.
// - stale: the campaign changed after prepare. Review it and prepare again.

type Prepared = Schemas["CampaignPrepare"];
type Mode = Prepared["mode"];
type Item = Schemas["ChecklistItem"];

/** What the owner confirmed. The campaign page shows it in a banner after the send. */
export interface SendNotice {
  campaignId: number;
  mode: Mode;
  recipients: number;
  scheduledAt: number | null;
  /** The IANA timezone of a schedule, or null. */
  timezone: string | null;
}

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
  onConfirmed,
}: {
  campaign: Schemas["Campaign"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed?: (notice: SendNotice) => void;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("send_now");
  const [timezone, setTimezone] = useState(() => rememberedTimeZone(current.id));
  // The wall-clock time in `timezone`, as the datetime-local input gives it.
  const [when, setWhen] = useState(() =>
    instantToWallTime(Date.now() + 60 * 60 * 1000, rememberedTimeZone(current.id)),
  );
  const [now, setNow] = useState(() => Date.now());
  const wall = useMemo(() => wallTimeToInstant(when, timezone), [when, timezone]);

  const prepare = useMutation({
    mutationFn: () => {
      if (mode === "schedule") rememberTimeZone(current.id, timezone);
      return unwrap(
        api.POST("/campaigns/{id}/prepare", {
          params: { path: { id: campaign.id } },
          body: {
            mode,
            ...(mode === "schedule" && wall.ok ? { scheduledAt: wall.instant, timezone } : {}),
          },
        }),
      );
    },
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
      const done = prepare.data;
      if (done) {
        onConfirmed?.({
          campaignId: campaign.id,
          mode: done.mode,
          recipients: done.estimate.recipients,
          scheduledAt: done.scheduledAt ?? null,
          timezone: done.timezone ?? null,
        });
      }
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
      <DialogContent
        className="max-h-[calc(100vh-32px)] max-w-[560px] overflow-y-auto"
        onEscapeKeyDown={(event) => {
          // Escape in an open timezone list closes the list, not the dialog.
          const target = event.target as HTMLElement | null;
          if (target?.getAttribute("aria-expanded") === "true") event.preventDefault();
        }}
      >
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
            timezone={timezone}
            onTimezone={setTimezone}
            whenError={wall.ok ? null : wall.reason === "gap" ? wall.message : null}
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
            <Button
              type="button"
              pending={prepare.isPending}
              disabled={mode === "schedule" && !wall.ok}
              onClick={() => prepare.mutate()}
            >
              Check and continue
            </Button>
          ) : stale || expired || prepared.blocked ? (
            <Button type="button" onClick={reset}>
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Check again
            </Button>
          ) : (
            <Button
              type="button"
              variant="brand"
              pending={confirm.isPending}
              disabled={!prepared.token}
              onClick={() => prepared.token && confirm.mutate(prepared.token)}
            >
              <SendIcon className="size-3.5" aria-hidden="true" />
              {prepared.mode === "schedule"
                ? `Schedule for ${formatScheduled(prepared.scheduledAt, prepared.timezone)}`
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
  timezone,
  onTimezone,
  whenError,
  error,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  when: string;
  onWhen: (value: string) => void;
  timezone: string;
  onTimezone: (zone: string) => void;
  whenError: string | null;
  error: string | null;
}) {
  const note = whenError ? null : ambiguityNote(when, timezone);
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            id="send-at"
            label="Send at"
            hint={note ?? "The time in the timezone that you pick."}
            error={whenError}
          >
            <Input
              id="send-at"
              type="datetime-local"
              value={when}
              aria-invalid={whenError ? true : undefined}
              aria-describedby={whenError ? "send-at-error" : "send-at-hint"}
              onChange={(event) => onWhen(event.target.value)}
            />
          </Field>
          <Field id="send-tz" label="Timezone">
            <TimeZonePicker id="send-tz" value={timezone} onChange={onTimezone} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/** The sending days of a connection with a daily cap (R28, AE6). */
function SendPlanNote({ plan }: { plan: NonNullable<Prepared["sendPlan"]> }) {
  const cap = plan.dailyCap.toLocaleString("en-US");
  return (
    <div
      className="flex items-start gap-3 rounded-xl bg-tone-lavender px-4 py-3 text-tone-lavender-foreground"
      data-testid="send-plan"
    >
      <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex flex-col gap-0.5 text-[13px]">
        <span className="font-semibold">
          {plan.days === 1
            ? "Sends in 1 day"
            : `Sends over ${plan.days} days, ends about ${formatDay(plan.endsAt)}`}
        </span>
        <span>
          The connection sends at most {cap} emails in 24 hours. It sent{" "}
          {plan.usedLast24h.toLocaleString("en-US")} in the last 24 hours. Welcome and confirmation
          emails use the same limit, so the end date can move.
        </span>
      </div>
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
      <dl className="m-0 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        <div className="flex flex-col gap-1 bg-popover p-4">
          <dt className="text-xs text-muted-foreground">Recipients (estimate)</dt>
          <dd className="m-0 text-[22px] leading-none" data-testid="estimate">
            <Figure value={prepared.estimate.recipients} />
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1 bg-popover p-4">
          <dt className="text-xs text-muted-foreground">Provider</dt>
          <dd className="m-0 truncate text-[13px] font-medium">
            {prepared.provider ? `${prepared.provider.providerName}` : "None"}
          </dd>
        </div>
        <div className="flex flex-col gap-1 bg-popover p-4">
          <dt className="text-xs text-muted-foreground">Mode</dt>
          <dd className="m-0 text-[13px] font-medium">
            {prepared.mode === "schedule"
              ? `Scheduled, ${formatScheduled(prepared.scheduledAt, prepared.timezone)}`
              : "Send now"}
          </dd>
        </div>
      </dl>
      <p className="m-0 text-xs text-muted-foreground">
        The count is an estimate. Envelopen takes the final list when the send starts, and checks
        each contact again just before its email goes out.
      </p>
      {prepared.sendPlan ? <SendPlanNote plan={prepared.sendPlan} /> : null}
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
