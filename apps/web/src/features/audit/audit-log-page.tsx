import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ScrollTextIcon } from "lucide-react";
import { useState } from "react";
import type { Schemas } from "@/api/client";
import {
  type AuditFilters,
  auditActionsQuery,
  auditLogQuery,
  campaignsQuery,
  connectionsQuery,
  domainsQuery,
  listsQuery,
  sessionQuery,
  tagsQuery,
  templatesQuery,
} from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Pill, type Tone } from "@/components/ui/pill";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, formatDateTime } from "@/features/contacts/shared";
import { actionSentence } from "./actions";

// The audit log (R8): who changed what, from which surface. Every write through the
// UI, the REST API, or MCP adds a row (KTD10). Newest first, with cursor pagination.
// Each row reads as a sentence, with the raw action key under it for power users. A
// target links to its record when the app has a page for it and the record still
// exists. Names come from the lists that the app loads anyway.

type Entry = Schemas["AuditEntry"];
type Surface = Entry["surface"];

const SURFACES: Record<Surface, { label: string; tone: Tone }> = {
  ui: { label: "UI", tone: "neutral" },
  rest: { label: "API", tone: "teal" },
  mcp: { label: "MCP", tone: "lavender" },
  system: { label: "System", tone: "salmon" },
};

function Actor({ entry, ownerName }: { entry: Entry; ownerName: string | undefined }) {
  if (entry.actorType === "api_key") {
    return (
      <span className="flex flex-col">
        <span className="font-medium">{entry.apiKeyName ?? "Deleted API key"}</span>
        <span className="text-xs text-muted-foreground">API key #{entry.apiKeyId}</span>
      </span>
    );
  }
  if (entry.actorType === "system") {
    return (
      <span className="text-muted-foreground">
        {entry.actorId === "setup_token" ? "Setup token" : "System"}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="font-medium">{ownerName ?? "Owner"}</span>
      {ownerName ? <span className="text-xs text-muted-foreground">Owner</span> : null}
    </span>
  );
}

type TargetLink =
  | { to: "/campaigns/$campaignId"; params: { campaignId: string } }
  | { to: "/contacts/$contactId"; params: { contactId: string } }
  | { to: "/templates/$templateId"; params: { templateId: string } }
  | { to: "/connections/domains/$domainId"; params: { domainId: string } }
  | { to: "/connections" }
  | { to: "/contacts"; search: { listId?: number; tagId?: number } };

interface ResolvedTarget {
  kind: string;
  name: string | undefined;
  link: TargetLink | undefined;
}

const KINDS: Record<string, string> = {
  provider_connection: "Email provider",
  sending_domain: "Sending domain",
  api_key: "API key",
  campaign_batch: "Campaign batch",
  saved_block: "Saved block",
  test_address: "Test address",
  test_send: "Test email",
};

/** Names of the records that the target column links to, from cached or small lists. */
function useTargetNames() {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const campaigns = useQuery(campaignsQuery(current.id));
  const templates = useQuery(templatesQuery(current.id));
  const connections = useQuery(connectionsQuery(current.id));
  const domains = useQuery(domainsQuery(current.id));
  const lists = useQuery(listsQuery(current.id));
  const tags = useQuery(tagsQuery(current.id));
  const byId = <T extends { id: number }>(items: T[] | undefined, name: (item: T) => string) =>
    new Map((items ?? []).map((item) => [String(item.id), name(item)]));
  // Contacts load page by page, so only the contacts already in the cache have a name.
  const contacts = new Map<string, string>();
  for (const [, data] of queryClient.getQueriesData<{
    pages?: { items: { id: number; email: string }[] }[];
  }>({ queryKey: ["ws", current.id, "contacts", "list"] })) {
    for (const page of data?.pages ?? []) {
      for (const contact of page.items) contacts.set(String(contact.id), contact.email);
    }
  }
  return {
    campaign: byId(campaigns.data?.items, (item) => item.name),
    template: byId(templates.data?.items, (item) => item.name),
    provider_connection: byId(connections.data?.items, (item) => item.name),
    sending_domain: byId(domains.data?.items, (item) => item.domain),
    list: byId(lists.data?.items, (item) => item.name),
    tag: byId(tags.data?.items, (item) => item.name),
    contact: contacts,
  };
}

type TargetNames = ReturnType<typeof useTargetNames>;

const GONE = new Set(["contacts.erase", "contacts.delete"]);

function resolveTarget(entry: Entry, names: TargetNames): ResolvedTarget | null {
  const type = entry.targetType;
  if (!type) return null;
  const id = entry.targetId ?? "";
  const kind = KINDS[type] ?? type.charAt(0).toUpperCase() + type.slice(1).replaceAll("_", " ");
  const known = type in names ? names[type as keyof TargetNames].get(id) : undefined;
  let link: TargetLink | undefined;
  // Link only to records that still exist: a name in the lists proves it.
  if (id && known !== undefined) {
    if (type === "campaign") link = { to: "/campaigns/$campaignId", params: { campaignId: id } };
    if (type === "template") link = { to: "/templates/$templateId", params: { templateId: id } };
    if (type === "provider_connection") link = { to: "/connections" };
    if (type === "sending_domain") {
      link = { to: "/connections/domains/$domainId", params: { domainId: id } };
    }
    if (type === "list") link = { to: "/contacts", search: { listId: Number(id) } };
    if (type === "tag") link = { to: "/contacts", search: { tagId: Number(id) } };
  }
  // The contact list is paged, so a contact links unless the row erased or deleted it.
  if (type === "contact" && id && !GONE.has(entry.action)) {
    link = { to: "/contacts/$contactId", params: { contactId: id } };
  }
  return { kind, name: known, link };
}

function Target({ entry, names }: { entry: Entry; names: TargetNames }) {
  const target = resolveTarget(entry, names);
  if (!target) return <span className="text-muted-foreground">None</span>;
  const id = entry.targetId ? `#${entry.targetId}` : "";
  const label = target.name ?? `${target.kind} ${id}`.trim();
  const content = (
    <span className="flex min-w-0 flex-col">
      <span className="max-w-[260px] truncate" title={label}>
        {label}
      </span>
      {target.name ? (
        <span className="text-xs text-muted-foreground">
          {target.kind} {id}
        </span>
      ) : null}
    </span>
  );
  if (!target.link) return content;
  return (
    <Link
      {...target.link}
      className="text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground"
    >
      {content}
    </Link>
  );
}

export function AuditLogPage() {
  const { current } = useCurrentWorkspace();
  const [filters, setFilters] = useState<AuditFilters>({});
  const log = useInfiniteQuery(auditLogQuery(current.id, filters));
  const actions = useQuery(auditActionsQuery(current.id));
  const session = useQuery(sessionQuery);
  const ownerName = session.data?.user.name || undefined;
  const names = useTargetNames();
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
                {actionSentence(action)}
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
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Surface</TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <TableRow key={entry.id} data-testid="audit-row">
                <TableCell className="figure whitespace-nowrap text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{actionSentence(entry.action)}</span>
                    <code className="font-mono text-[11.5px] text-muted-foreground">
                      {entry.action}
                    </code>
                  </span>
                </TableCell>
                <TableCell>
                  <Target entry={entry} names={names} />
                </TableCell>
                <TableCell>
                  <Actor entry={entry} ownerName={ownerName} />
                </TableCell>
                <TableCell>
                  <Pill tone={SURFACES[entry.surface].tone}>{SURFACES[entry.surface].label}</Pill>
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
