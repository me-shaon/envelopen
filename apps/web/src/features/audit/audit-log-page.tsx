import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ScrollTextIcon } from "lucide-react";
import { useState } from "react";
import type { Schemas } from "@/api/client";
import { type AuditFilters, auditActionsQuery, auditLogQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Pill, type Tone } from "@/components/ui/pill";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, formatDateTime } from "@/features/contacts/shared";

// The audit log (R8): who changed what, from which surface. Every write through the
// UI, the REST API, or MCP adds a row (KTD10). Newest first, with cursor pagination.

type Entry = Schemas["AuditEntry"];
type Surface = Entry["surface"];

const SURFACES: Record<Surface, { label: string; tone: Tone }> = {
  ui: { label: "UI", tone: "neutral" },
  rest: { label: "API", tone: "teal" },
  mcp: { label: "MCP", tone: "lavender" },
  system: { label: "System", tone: "salmon" },
};

function Actor({ entry }: { entry: Entry }) {
  if (entry.actorType === "api_key") {
    return (
      <span className="flex flex-col">
        <span className="font-medium">{entry.apiKeyName ?? "Deleted API key"}</span>
        <span className="text-xs text-muted-foreground">API key #{entry.apiKeyId}</span>
      </span>
    );
  }
  if (entry.actorType === "system") return <span className="text-muted-foreground">System</span>;
  return <span className="font-medium">Owner</span>;
}

function Target({ entry }: { entry: Entry }) {
  if (!entry.targetType) return <span className="text-muted-foreground">None</span>;
  const label = `${entry.targetType.replaceAll("_", " ")}${entry.targetId ? ` #${entry.targetId}` : ""}`;
  return <span>{label}</span>;
}

export function AuditLogPage() {
  const { current } = useCurrentWorkspace();
  const [filters, setFilters] = useState<AuditFilters>({});
  const log = useInfiniteQuery(auditLogQuery(current.id, filters));
  const actions = useQuery(auditActionsQuery(current.id));
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = filters.surface !== undefined || filters.action !== undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Settings
        </Link>
        <PageHeader
          title="Audit log"
          description="Every change in this workspace, with who made it and from where."
        />
      </div>

      <form
        aria-label="Filter the audit log"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex w-[180px] flex-col gap-1.5">
          <Label htmlFor="audit-surface">Surface</Label>
          <NativeSelect
            id="audit-surface"
            value={filters.surface ?? ""}
            onChange={(event) =>
              setFilters((value) => ({
                ...value,
                surface: (event.target.value || undefined) as Surface | undefined,
              }))
            }
          >
            <option value="">All surfaces</option>
            {(Object.keys(SURFACES) as Surface[]).map((surface) => (
              <option key={surface} value={surface}>
                {SURFACES[surface].label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex w-[260px] flex-col gap-1.5">
          <Label htmlFor="audit-action">Action</Label>
          <NativeSelect
            id="audit-action"
            value={filters.action ?? ""}
            onChange={(event) =>
              setFilters((value) => ({ ...value, action: event.target.value || undefined }))
            }
          >
            <option value="">All actions</option>
            {(actions.data?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </NativeSelect>
        </div>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        ) : null}
      </form>

      {log.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          {errorText(log.error)}
        </p>
      ) : log.isPending ? (
        <div className="h-48 rounded-xl border border-border bg-muted" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollTextIcon}
          title={filtered ? "No entries match the filters" : "No entries yet"}
        >
          Changes from the app, the API, and MCP show here.
        </EmptyState>
      ) : (
        <Table aria-label="Audit log entries">
          <thead>
            <tr>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Surface</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <TableRow key={entry.id} data-testid="audit-row">
                <TableCell className="figure whitespace-nowrap text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </TableCell>
                <TableCell>
                  <Actor entry={entry} />
                </TableCell>
                <TableCell>
                  <Pill tone={SURFACES[entry.surface].tone}>{SURFACES[entry.surface].label}</Pill>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-[12.5px]">{entry.action}</code>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <Target entry={entry} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
      {log.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            onClick={() => void log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The Settings entry that opens the audit log. */
export function AuditLogSection() {
  return (
    <section aria-labelledby="audit-title" className="flex flex-col gap-3">
      <SectionHeader id="audit-title" title="Audit log" />
      <p className="m-0 text-[13px] text-muted-foreground">
        Envelopen records every change, with the actor and the surface: the app, the API, or MCP.
        Exports and erases of contact data are in it too.
      </p>
      <div>
        <Button asChild variant="outline">
          <Link to="/settings/audit-log">Open the audit log</Link>
        </Button>
      </div>
    </section>
  );
}
