import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { type Connection, Note, type Provider } from "./shared";

// The daily cap of a connection (U19, R27). Campaigns, welcome emails, and form
// confirmation emails share it. A campaign larger than the cap sends over several days.

/** The published limit that the preset of the connection links to, or null. */
export function capSourceOf(
  connection: Connection,
  providers: readonly Provider[] | undefined,
): { label: string; url: string } | null {
  const provider = providers?.find((item) => item.id === connection.provider);
  const preset = provider?.presets.find((item) => item.id === connection.preset);
  return preset?.capSource ?? null;
}

function dailyUsageQuery(workspaceId: number, id: number) {
  return {
    queryKey: ["ws", workspaceId, "connections", id, "daily-usage"],
    queryFn: () => unwrap(api.GET("/connections/{id}/daily-usage", { params: { path: { id } } })),
  };
}

/** The use of the cap in the last 24 hours, and the confirmation emails that wait. */
export function DailyUsage({ connection }: { connection: Connection }) {
  const { current } = useCurrentWorkspace();
  const usage = useQuery({
    ...dailyUsageQuery(current.id, connection.id),
    enabled: connection.dailyCap !== null,
  });
  if (connection.dailyCap === null || !usage.data) return null;
  const waiting = usage.data.waitingConfirmations;
  return (
    <>
      <span className="text-xs text-muted-foreground" data-testid="daily-usage">
        {usage.data.usedLast24h.toLocaleString("en-US")} of{" "}
        {connection.dailyCap.toLocaleString("en-US")} sent in the last 24 hours.
      </span>
      {waiting > 0 ? (
        <Note tone="salmon" title="Confirmation emails wait" testId="waiting-confirmations">
          {waiting === 1
            ? "1 form confirmation email waits"
            : `${waiting.toLocaleString("en-US")} form confirmation emails wait`}{" "}
          for room under the daily limit. They go out when the last 24 hours have room. Raise the
          limit if your provider allows more.
        </Note>
      ) : null}
    </>
  );
}

export function DailyCapDialog({
  connection,
  capSource,
  onOpenChange,
}: {
  connection: Connection | null;
  capSource: { label: string; url: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? (connection?.dailyCap ? String(connection.dailyCap) : "");
  const save = useMutation({
    mutationFn: (dailyCap: number | null) =>
      unwrap(
        api.POST("/connections/{id}/daily-cap", {
          params: { path: { id: connection?.id ?? 0 } },
          body: { dailyCap },
        }),
      ),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      setValue(null);
      onOpenChange(false);
      toast(
        saved.dailyCap === null
          ? `${saved.name} has no daily limit now.`
          : `${saved.name} sends at most ${saved.dailyCap.toLocaleString("en-US")} emails a day.`,
      );
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = shown.trim();
    save.mutate(text ? Number(text) : null);
  }

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) {
          save.reset();
          setValue(null);
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-[460px]">
        <DialogHeader
          title="Daily sending limit"
          description="The most emails that Envelopen sends through this connection in any 24 hours."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(save.error)} />
          <Field
            id="daily-cap"
            label="Emails in 24 hours (optional)"
            hint="Leave it empty for no limit. Campaigns, welcome emails, and confirmation emails share the limit. A larger campaign sends over several days."
          >
            <Input
              id="daily-cap"
              type="number"
              min={1}
              max={10_000_000}
              step={1}
              inputMode="numeric"
              value={shown}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby="daily-cap-hint"
            />
          </Field>
          {capSource ? (
            <a
              href={capSource.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] underline underline-offset-2"
            >
              {capSource.label}
              <ArrowUpRightIcon className="size-3" aria-hidden="true" />
            </a>
          ) : null}
          <Note tone="lavender">
            A new limit applies to the emails after the change. A campaign that sends already keeps
            its plan, and each later email waits for room under the new limit.
          </Note>
          <DialogFooter>
            <Button type="submit" pending={save.isPending}>
              Save limit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
