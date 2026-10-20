import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, unwrap } from "@/api/client";
import { workspaceSettingsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { useCurrentWorkspace } from "@/components/workspace-context";

// Tracking and event retention for the workspace (R45, R51). A campaign can turn
// tracking off for itself. With tracking off here, no campaign of the workspace adds
// the pixel or rewrites links.

const MIN_DAYS = 30;
const MAX_DAYS = 730;

interface Draft {
  trackingOpens: boolean;
  trackingClicks: boolean;
  days: string;
}

export function TrackingSection() {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const query = useQuery(workspaceSettingsQuery(current.id));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data && draft === null) {
      setDraft({
        trackingOpens: query.data.trackingOpens,
        trackingClicks: query.data.trackingClicks,
        days: String(query.data.eventRetentionDays),
      });
    }
  }, [query.data, draft]);

  const save = useMutation({
    mutationFn: (value: Draft) =>
      unwrap(
        api.PATCH("/workspace", {
          body: {
            trackingOpens: value.trackingOpens,
            trackingClicks: value.trackingClicks,
            eventRetentionDays: Number(value.days),
          },
        }),
      ),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: workspaceSettingsQuery(current.id).queryKey,
      });
    },
  });

  const days = Number(draft?.days);
  const daysError =
    draft && (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS)
      ? `Enter a whole number from ${MIN_DAYS} to ${MAX_DAYS}.`
      : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || daysError) return;
    save.mutate(draft);
  }

  function update(next: Partial<Draft>) {
    setSaved(false);
    setDraft((value) => (value ? { ...value, ...next } : value));
  }

  return (
    <section id="tracking" aria-labelledby="tracking-title" className="flex flex-col gap-4">
      <SectionHeader
        id="tracking-title"
        title="Tracking"
        aside="Applies to every campaign in this workspace."
      />
      {draft === null ? (
        <LoadingRegion
          label="Loading the tracking settings"
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
        >
          {["w-24", "w-[88px]"].map((width) => (
            <div key={width} className="flex items-start gap-2.5">
              <Skeleton className="size-4 rounded-[5px]" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className={`h-3.5 rounded-sm ${width}`} />
                <Skeleton className="h-3 w-56 rounded-sm" />
              </div>
            </div>
          ))}
          <div className="flex max-w-[260px] flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40 rounded-sm" />
            <Skeleton className="h-9 rounded-[9px]" />
          </div>
          <Skeleton className="h-9 w-[168px] rounded-[9px]" />
        </LoadingRegion>
      ) : (
        <form
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
          onSubmit={onSubmit}
        >
          <FormError
            message={
              save.error instanceof Error
                ? save.error.message
                : save.error
                  ? "Something went wrong. Try again."
                  : null
            }
          />
          <div className="flex flex-col gap-2">
            {(
              [
                ["trackingOpens", "Track opens", "Adds a tracking pixel to each email."],
                [
                  "trackingClicks",
                  "Track clicks",
                  "Sends links through a redirect that counts clicks.",
                ],
              ] as const
            ).map(([key, label, hint]) => (
              <div key={key} className="flex items-start gap-2.5">
                <Checkbox
                  id={`workspace-${key}`}
                  checked={draft[key]}
                  onCheckedChange={(checked) => update({ [key]: checked === true })}
                  aria-describedby={`workspace-${key}-hint`}
                />
                <div className="flex flex-col">
                  <Label htmlFor={`workspace-${key}`} className="cursor-pointer font-normal">
                    {label}
                  </Label>
                  <span id={`workspace-${key}-hint`} className="text-xs text-muted-foreground">
                    {hint}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <Field
            id="workspace-retention"
            label="Keep raw events for (days)"
            hint="Opens, clicks, and provider events older than this are deleted. Campaign totals stay."
            error={daysError}
            className="max-w-[260px]"
          >
            <Input
              id="workspace-retention"
              inputMode="numeric"
              value={draft.days}
              onChange={(event) => update({ days: event.target.value })}
              aria-invalid={daysError ? true : undefined}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" pending={save.isPending} disabled={daysError !== null}>
              Save tracking settings
            </Button>
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
