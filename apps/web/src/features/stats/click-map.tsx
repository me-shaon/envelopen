import { useQuery } from "@tanstack/react-query";
import { FileXIcon, MousePointerClickIcon } from "lucide-react";
import { useState } from "react";
import { clickMapQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { barWidth, formatCount, formatRate } from "./format";

// The click map (R47): the email with each tracked link's human clicks next to it, and
// the same numbers as a list. The HTML renders in an iframe with an empty `sandbox`
// attribute, as in the editor preview (KTD27). The counts are CSS labels that the
// Worker added, so the frame needs no script. The empty sandbox does not stop the
// render. Each state has its own panel: loading shows a skeleton, an error shows the
// message, and no HTML or no clicks yet shows an empty state instead of a blank frame.

export function ClickMap({ campaignId }: { campaignId: number }) {
  const { current } = useCurrentWorkspace();
  const map = useQuery(clickMapQuery(current.id, campaignId));
  const data = map.data;
  const [showEmail, setShowEmail] = useState(false);
  return (
    <section aria-labelledby="click-map-title" className="flex flex-col gap-4">
      <SectionHeader
        id="click-map-title"
        title="Clicks per link"
        aside={data ? `${formatCount(data.totalClicks)} clicks by people` : null}
      />
      {map.isError ? (
        <FormError message={errorText(map.error)} />
      ) : !data ? (
        <div className="flex flex-wrap gap-6" aria-hidden="true">
          <div className="h-40 flex-[1_1_260px] animate-pulse rounded-xl border border-border bg-muted" />
          <div className="h-80 flex-[2_1_380px] animate-pulse rounded-xl border border-border bg-muted" />
        </div>
      ) : !data.trackClicks ? (
        <EmptyState icon={MousePointerClickIcon} title="Click tracking was off">
          Links in this campaign went straight to their pages, so Envelopen has no clicks to show.
        </EmptyState>
      ) : data.links.length === 0 ? (
        <EmptyState icon={MousePointerClickIcon} title="No tracked links">
          The email has no links that Envelopen tracks. Unsubscribe, mailto, and personalized links
          are not tracked.
        </EmptyState>
      ) : (
        <div className="flex flex-wrap gap-6">
          <ul
            aria-label="Links"
            className="m-0 flex min-w-0 flex-[1_1_260px] list-none flex-col gap-0 self-start overflow-hidden rounded-xl border border-border p-0"
          >
            {data.links.map((link) => (
              <li
                key={link.index}
                data-testid="click-map-link"
                className="flex flex-col gap-2 border-b border-hairline px-4 py-3 last:border-b-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-xs" title={link.url}>
                    {link.url}
                  </span>
                  <span className="figure shrink-0 text-[13px]">{formatCount(link.clicks)}</span>
                </div>
                <div className="h-[3px] overflow-hidden rounded-full bg-track" aria-hidden="true">
                  <div
                    className="h-[3px] rounded-full bg-chart-1"
                    style={{ width: `${barWidth(link.share)}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {link.share === null ? "No clicks yet" : `${formatRate(link.share)} of clicks`}
                </span>
              </li>
            ))}
          </ul>
          {data.html === null ? (
            <EmptyState
              icon={FileXIcon}
              title="The email is not available"
              className="min-w-0 flex-[2_1_380px] self-start"
            >
              Envelopen has no stored HTML for this campaign. The list shows the clicks per link.
            </EmptyState>
          ) : data.totalClicks === 0 && !showEmail ? (
            <EmptyState
              icon={MousePointerClickIcon}
              title="No clicks yet"
              className="min-w-0 flex-[2_1_380px] self-start"
              action={
                <Button variant="outline" size="sm" onClick={() => setShowEmail(true)}>
                  Show the email
                </Button>
              }
            >
              When people click, each tracked link in the email shows its count.
            </EmptyState>
          ) : (
            <div className="flex min-w-0 flex-[2_1_380px] justify-center rounded-xl border border-border bg-muted px-3 py-4">
              <iframe
                title="Email with clicks per link"
                sandbox=""
                srcDoc={data.html}
                referrerPolicy="no-referrer"
                className="h-[560px] w-full max-w-[640px] rounded-lg border-0 bg-white"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
