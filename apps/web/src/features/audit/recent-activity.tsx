import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Schemas } from "@/api/client";
import { auditLogQuery, campaignsQuery } from "@/api/queries";
import { formatDateTime } from "@/features/contacts/shared";

// The overview's activity panel: the latest notable audit rows, newest first. A run of
// the same action (for example 240 contact upserts from one import) shows as one item.

type Entry = Schemas["AuditEntry"];

const MAX_ITEMS = 6;

/** How each notable action reads. Other actions (prepare, reads of settings) stay hidden. */
const LABELS: Record<string, (count: number, name: string | undefined) => string> = {
  "setup.owner_created": () => "Workspace created.",
  "connections.create": () => "Email provider connected.",
  "domains.create": () => "Sending domain added.",
  "campaigns.send_test": () => "Test email sent.",
  "campaigns.create": (n, name) =>
    n > 1 ? `${n} campaigns created.` : `Campaign ${quote(name)}created.`,
  "campaigns.confirm": (n, name) =>
    n > 1 ? `${n} campaigns confirmed.` : `Campaign ${quote(name)}confirmed.`,
  "campaigns.sent": (n, name) => (n > 1 ? `${n} campaigns sent.` : `Campaign ${quote(name)}sent.`),
  "campaigns.pause": (_n, name) => `Campaign ${quote(name)}paused.`,
  "campaigns.resume": (_n, name) => `Campaign ${quote(name)}resumed.`,
  "campaigns.cancel": (_n, name) => `Campaign ${quote(name)}canceled.`,
  "campaigns.follow_up": () => "Follow-up draft created.",
  "contacts.upsert": (n) =>
    n > 1 ? `${n} contacts added or updated.` : "Contact added or updated.",
  "contacts.update": (n) => (n > 1 ? `${n} contacts changed.` : "Contact changed."),
  "contacts.erase": (n) => (n > 1 ? `${n} contacts erased.` : "Contact erased."),
  "contacts.delete": (n) => (n > 1 ? `${n} contacts deleted.` : "Contact deleted."),
  "imports.start": () => "Contact import started.",
  "lists.create": (n) => (n > 1 ? `${n} lists created.` : "List created."),
  "tags.create": (n) => (n > 1 ? `${n} tags created.` : "Tag created."),
  "templates.create": (n) => (n > 1 ? `${n} templates created.` : "Template created."),
  "suppressions.add": (n) => (n > 1 ? `${n} addresses suppressed.` : "Address suppressed."),
  "api_keys.create": () => "API key created.",
};

function quote(name: string | undefined) {
  return name ? `"${name}" ` : "";
}

interface Item {
  key: number;
  text: string;
  createdAt: number;
  surface: Entry["surface"];
}

function group(entries: Entry[], names: Map<string, string>): Item[] {
  const items: Item[] = [];
  let run: { first: Entry; count: number } | undefined;
  const flush = () => {
    if (!run) return;
    const label = LABELS[run.first.action];
    if (label) {
      const name = run.first.targetId ? names.get(run.first.targetId) : undefined;
      items.push({
        key: run.first.id,
        text: label(run.count, name),
        createdAt: run.first.createdAt,
        surface: run.first.surface,
      });
    }
    run = undefined;
  };
  for (const entry of entries) {
    if (!LABELS[entry.action]) continue;
    if (run && run.first.action === entry.action && !entry.action.startsWith("campaigns.")) {
      run.count++;
      continue;
    }
    flush();
    run = { first: entry, count: 1 };
  }
  flush();
  return items.slice(0, MAX_ITEMS);
}

const SURFACE_TEXT: Record<Entry["surface"], string> = {
  ui: "",
  rest: " · API",
  mcp: " · MCP",
  system: " · System",
};

export function RecentActivity({ workspaceId }: { workspaceId: number }) {
  const log = useInfiniteQuery(auditLogQuery(workspaceId, {}));
  const campaigns = useQuery(campaignsQuery(workspaceId));
  const names = new Map(
    (campaigns.data?.items ?? []).map((campaign) => [String(campaign.id), campaign.name]),
  );
  const items = group(log.data?.pages[0]?.items ?? [], names);

  if (items.length === 0) {
    return (
      <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
        <span className="mt-[5px] size-2 rounded-full bg-chart-2" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] leading-[1.45]">No activity yet.</span>
          <span className="text-xs text-muted-foreground">
            Sends, imports, and other changes will show here.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="recent-activity">
        {items.map((item) => (
          <li key={item.key} className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
            <span className="mt-[5px] size-2 rounded-full bg-chart-2" aria-hidden="true" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] leading-[1.45]">{item.text}</span>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(item.createdAt)}
                {SURFACE_TEXT[item.surface]}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <Link
        to="/settings/audit-log"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Open the audit log
      </Link>
    </div>
  );
}
