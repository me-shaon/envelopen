import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MailPlusIcon, PlusIcon } from "lucide-react";
import type { Schemas } from "@/api/client";
import { listsQuery, welcomeSeriesListQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, PageTop } from "@/features/contacts/shared";
import { formatDate } from "@/lib/format";

// Welcome series (U10, R15). Each list can have one series of 1 to 5 emails. A contact
// who joins the list through a confirmed form signup, or through an add with the start
// option, gets each email once, after its delay.

export type WelcomeSeries = Schemas["WelcomeSeries"];

/** The emails that went out for a series, over all steps. */
export function sentCount(series: WelcomeSeries): number {
  return series.stats.reduce((sum, step) => sum + step.sent, 0);
}

export function WelcomePage() {
  const { current } = useCurrentWorkspace();
  const navigate = useNavigate();
  const series = useQuery(welcomeSeriesListQuery(current.id));
  const lists = useQuery(listsQuery(current.id));
  const listName = (id: number) => lists.data?.items.find((list) => list.id === id)?.name;
  const items = series.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop
        title="Welcome series"
        description="A short run of emails that greets each new subscriber of a list, one email at a time."
        actions={
          <Button
            onClick={() => void navigate({ to: "/welcome/$seriesId", params: { seriesId: "new" } })}
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New series
          </Button>
        }
      />
      {series.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          {errorText(series.error)}
        </p>
      ) : series.isPending ? (
        <TableSkeleton label="Loading the welcome series" rows={3} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MailPlusIcon}
          title="No welcome series yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/welcome/$seriesId" params={{ seriesId: "new" }}>
                Create your first series
              </Link>
            </Button>
          }
        >
          A series sends 1 to 5 emails to each new subscriber of a list, with a wait before each
          email. The editor can give you a starter welcome email to begin with.
        </EmptyState>
      ) : (
        <Table aria-label="Welcome series">
          <thead>
            <tr>
              <TableHead>Series</TableHead>
              <TableHead>List</TableHead>
              <TableHead>Emails</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Contacts</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Updated</TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <TableRow key={item.id} data-testid="welcome-row">
                <TableCell className="font-medium">
                  <Link
                    to="/welcome/$seriesId"
                    params={{ seriesId: String(item.id) }}
                    className="hover:underline"
                  >
                    {item.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[220px] truncate text-muted-foreground">
                  {listName(item.listId) ?? `List ${item.listId}`}
                </TableCell>
                <TableCell className="figure">{item.steps.length}</TableCell>
                <TableCell>
                  <Pill tone={item.enabled ? "teal" : "neutral"}>
                    {item.enabled ? "On" : "Off"}
                  </Pill>
                </TableCell>
                <TableCell className="figure">{item.entered}</TableCell>
                <TableCell className="figure">{sentCount(item)}</TableCell>
                <TableCell className="figure text-muted-foreground">
                  {formatDate(item.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
