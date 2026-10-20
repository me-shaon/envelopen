import { useQuery } from "@tanstack/react-query";
import { usageQuery } from "@/api/queries";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { FormError } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { formatUtc } from "@/features/campaigns/shared";
import { errorText } from "@/features/contacts/shared";
import { barWidth, formatCount } from "@/features/stats/format";
import { guideUrl } from "@/lib/guides";
import { cn } from "@/lib/utils";
import { formatUtcClock, USAGE_STATE } from "./shared";

// The usage view (R4, R71, KTD24). D1 rows written is the limit that Envelopen measures:
// each invocation reports its writes to the UsageMeter Durable Object. The view warns
// at 80%, shows the reset at 00:00 UTC, and advises Workers Paid near the limit. The
// other Free limits are listed with their values, marked as not measured.

const WARNING_RATIO = 0.8;

function hoursUntil(ms: number): string {
  const minutes = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function UsagePage() {
  const usage = useQuery(usageQuery);
  const data = usage.data;
  return (
    <div className="flex max-w-[760px] flex-col gap-12">
      <PageHeader
        title="Usage"
        description="Today's use of the Workers Free daily limits, for the whole deployment."
      />
      {!data ? (
        usage.isPending ? (
          <LoadingRegion label="Loading the usage">
            <Skeleton className="h-[180px] rounded-xl" />
          </LoadingRegion>
        ) : (
          <FormError message={errorText(usage.error)} />
        )
      ) : (
        <>
          {data.d1Writes.state !== "ok" ? (
            <div
              role="status"
              data-testid="usage-banner"
              className={cn(
                "flex flex-col gap-0.5 rounded-xl px-4 py-3 text-[13px]",
                data.d1Writes.state === "limit"
                  ? "bg-tone-danger text-tone-danger-foreground"
                  : "bg-tone-salmon text-tone-salmon-foreground",
              )}
            >
              <span className="font-semibold">
                {data.d1Writes.state === "limit"
                  ? "D1 reached its daily write limit"
                  : "D1 writes are above 80% of today's limit"}
              </span>
              <span>
                {data.d1Writes.state === "limit"
                  ? `Campaigns are paused, and writes such as unsubscribes fail until ${formatUtc(data.platformLimit?.until ?? data.resetsAt)}. Sending resumes on its own.`
                  : `Campaigns pause at the limit and resume after ${formatUtc(data.resetsAt)}.`}{" "}
                {data.paidHint}
              </span>
            </div>
          ) : null}

          <section
            aria-labelledby="d1-title"
            className="flex flex-col gap-4 rounded-xl border border-border p-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="d1-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
                D1 rows written today
              </h2>
              <Pill tone={USAGE_STATE[data.d1Writes.state].tone}>
                {USAGE_STATE[data.d1Writes.state].label}
              </Pill>
            </div>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div className="flex flex-col">
                <span className="figure text-[34px] leading-none" data-testid="usage-used">
                  {formatCount(data.d1Writes.used)}
                </span>
                <span className="mt-1.5 text-xs text-muted-foreground">
                  of {formatCount(data.d1Writes.limit)} on Workers Free
                </span>
              </div>
              <div className="flex flex-col">
                <span className="figure text-[20px] leading-[1.2]">
                  {formatCount(data.d1Writes.remaining)}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">left today</span>
              </div>
              <div className="flex flex-col">
                <span className="figure text-[20px] leading-[1.2]">
                  {formatUtcClock(data.resetsAt)}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  reset {hoursUntil(data.resetsAt)}
                </span>
              </div>
            </div>
            <div className="relative">
              <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-track">
                <div
                  className={cn(
                    "h-1 rounded-full",
                    data.d1Writes.state === "ok" ? "bg-chart-2" : "bg-chart-1",
                  )}
                  style={{ width: `${barWidth(data.d1Writes.ratio)}%` }}
                />
              </div>
              <span
                className="absolute -top-1 h-3 w-px bg-muted-foreground/50"
                style={{ left: `${WARNING_RATIO * 100}%` }}
                aria-hidden="true"
              />
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              Envelopen warns at 80%. At the limit, D1 rejects writes: campaigns pause and resume
              after 00:00 UTC. Workers Paid has no daily D1 write limit.{" "}
              <a
                href={guideUrl("docs/guides/cloudflare-platform.md")}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Platform guide
              </a>
            </p>
          </section>

          <section aria-labelledby="limits-title" className="flex flex-col gap-4">
            <SectionHeader
              id="limits-title"
              title="Workers plan limits"
              aside="The Worker cannot read the account's plan"
            />
            <Table aria-label="Workers plan limits">
              <thead>
                <tr>
                  <TableHead>Limit</TableHead>
                  <TableHead>Free</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead className="text-right">Today</TableHead>
                </tr>
              </thead>
              <tbody>
                {data.limits.map((limit) => (
                  <TableRow key={limit.id}>
                    <TableCell className="font-medium">{limit.label}</TableCell>
                    <TableCell className="text-muted-foreground">{limit.free}</TableCell>
                    <TableCell className="text-muted-foreground">{limit.paid}</TableCell>
                    <TableCell className="text-right">
                      {limit.measured && limit.used !== null ? (
                        <span className="figure">{formatCount(limit.used)}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not measured</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
