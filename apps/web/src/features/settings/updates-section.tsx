import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { guideUrl } from "@/lib/guides";

// The update check (packages/core/src/settings/updates.ts). The cron asks GitHub for the
// newest release once a day. The owner can check now, and turn the daily check off.

const UPDATING_GUIDE = guideUrl("docs/guides/updating.md");

export const updateStatusQuery = queryOptions({
  queryKey: ["update-status"],
  queryFn: () => unwrap(api.GET("/settings/updates")),
  staleTime: 5 * 60_000,
});

function formatCheckedAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ExternalAnchor({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
    >
      {children}
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
    </a>
  );
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function UpdatesSection() {
  const queryClient = useQueryClient();
  const query = useQuery(updateStatusQuery);
  const onSuccess = (data: NonNullable<typeof query.data>) =>
    queryClient.setQueryData(updateStatusQuery.queryKey, data);

  const setCheck = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.PATCH("/settings/updates", { body: { enabled } })),
    onSuccess,
  });
  const checkNow = useMutation({
    mutationFn: () => unwrap(api.POST("/settings/updates/check")),
    onSuccess,
  });

  const data = query.data;
  let summary = "";
  if (data) {
    if (data.checkedAt === null) {
      summary = data.enabled ? "The first check runs within a day." : "The daily check is off.";
    } else if (data.updateAvailable) {
      summary = `Version ${data.latestVersion} is available.`;
    } else {
      summary = "This is the newest version.";
    }
    if (data.checkedAt !== null) summary += ` Last check: ${formatCheckedAt(data.checkedAt)}.`;
  }

  return (
    <section id="updates" aria-labelledby="updates-title" className="flex flex-col gap-4">
      <SectionHeader id="updates-title" title="Updates" aside="Applies to every workspace." />
      {!data ? (
        <LoadingRegion
          label="Loading the update status"
          className="flex flex-col gap-5 rounded-xl border border-border p-5"
        >
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-48 rounded-sm" />
            <Skeleton className="h-3 w-72 max-w-full rounded-sm" />
          </div>
          <Skeleton className="h-[30px] w-[110px] rounded-md" />
          <div className="flex items-start gap-2.5">
            <Skeleton className="size-4 rounded-[5px]" />
            <Skeleton className="h-3.5 w-44 rounded-sm" />
          </div>
        </LoadingRegion>
      ) : (
        <div className="flex flex-col gap-5 rounded-xl border border-border p-5">
          <FormError message={errorMessage(checkNow.error) ?? errorMessage(setCheck.error)} />
          <div className="flex flex-col gap-1 text-[13px]">
            <p className="m-0 font-medium">This deployment runs Envelopen {data.currentVersion}.</p>
            <p className="m-0 text-muted-foreground" role="status">
              {summary}
            </p>
            {data.updateAvailable && data.releaseUrl ? (
              <p className="m-0 flex flex-wrap gap-x-4 gap-y-1">
                <ExternalAnchor href={data.releaseUrl}>What changed</ExternalAnchor>
                <ExternalAnchor href={UPDATING_GUIDE}>How to update</ExternalAnchor>
              </p>
            ) : null}
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              pending={checkNow.isPending}
              onClick={() => {
                setCheck.reset();
                checkNow.mutate();
              }}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Check now
            </Button>
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="update-check"
              checked={data.enabled}
              disabled={setCheck.isPending}
              onCheckedChange={(checked) => {
                checkNow.reset();
                setCheck.mutate(checked === true);
              }}
              aria-describedby="update-check-hint"
            />
            <div className="flex flex-col">
              <Label htmlFor="update-check" className="cursor-pointer font-normal">
                Check for new versions every day
              </Label>
              <p id="update-check-hint" className="m-0 text-xs text-muted-foreground">
                Envelopen asks GitHub for the newest release of me-shaon/envelopen. It sends no
                workspace data.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
