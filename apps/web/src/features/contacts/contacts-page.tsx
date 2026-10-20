import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DownloadIcon, SearchIcon, UploadIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import {
  type ContactFilters,
  contactCountsQuery,
  contactsQuery,
  listsQuery,
  tagsQuery,
} from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Pill } from "@/components/ui/pill";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { Refreshing } from "@/components/ui/spinner";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CONSENT,
  ContactsNav,
  errorText,
  Figure,
  formatBytes,
  formatDateTime,
  PageTop,
  StatusPill,
} from "./shared";

type Contact = Schemas["Contact"];

const STATS = [
  { key: "subscribed", label: "Subscribed", color: "bg-chart-2" },
  { key: "unsubscribed", label: "Unsubscribed", color: "bg-chart-1" },
  { key: "suppressed", label: "Suppressed", color: "bg-chart-4" },
] as const;

function StatStrip() {
  const { current } = useCurrentWorkspace();
  const counts = useQuery(contactCountsQuery(current.id, {}));
  const data = counts.data;
  return (
    <section aria-label="Audience totals">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <div className="flex flex-col gap-2 bg-background p-[18px]">
          <span className="text-xs text-muted-foreground">Contacts</span>
          <span className="text-[26px] leading-[1.1]" data-testid="contacts-total">
            {data ? <Figure value={data.total} /> : <Skeleton className="h-[29px] w-16" />}
          </span>
          <div className="h-[3px] rounded-full bg-track" />
          <span className="text-xs text-muted-foreground">In {current.name}</span>
        </div>
        {STATS.map((stat) => {
          const value = data?.[stat.key] ?? 0;
          const share = data && data.total > 0 ? Math.round((value / data.total) * 100) : 0;
          return (
            <div key={stat.key} className="flex flex-col gap-2 bg-background p-[18px]">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className="text-[26px] leading-[1.1]">
                {data ? <Figure value={value} /> : <Skeleton className="h-[29px] w-14" />}
              </span>
              <div className="h-[3px] overflow-hidden rounded-full bg-track">
                <div
                  className={`h-[3px] rounded-full transition-[width] duration-500 ease-(--ease-calm) ${stat.color}`}
                  style={{ width: `${share}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                <span className="figure">{share}%</span> of contacts
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Filters({
  filters,
  onChange,
}: {
  filters: ContactFilters;
  onChange: (filters: ContactFilters) => void;
}) {
  const { current } = useCurrentWorkspace();
  const lists = useQuery(listsQuery(current.id));
  const tags = useQuery(tagsQuery(current.id));
  const [search, setSearch] = useState(filters.search ?? "");
  // The latest filters, so the debounced search keeps a list or tag picked meanwhile.
  const latest = useRef({ filters, onChange });
  latest.current = { filters, onChange };
  // The last search this field sent. A different search in the URL came from outside,
  // for example the back button, so the field takes it.
  const sent = useRef(filters.search ?? "");
  const urlSearch = filters.search ?? "";
  useEffect(() => {
    if (urlSearch !== sent.current) {
      sent.current = urlSearch;
      setSearch(urlSearch);
    }
  }, [urlSearch]);

  // The search runs 300 ms after the last keystroke. Enter runs it at once.
  useEffect(() => {
    const value = search.trim();
    if ((latest.current.filters.search ?? "") === value) return;
    const timer = setTimeout(() => {
      sent.current = value;
      latest.current.onChange({ ...latest.current.filters, search: value || undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    sent.current = search.trim();
    onChange({ ...filters, search: search.trim() || undefined });
  }

  return (
    <form
      aria-label="Filter contacts"
      onSubmit={onSubmit}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative min-w-[220px] flex-[2_1_240px]">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Search by email or name"
          placeholder="Search by email or name"
          className="pl-8"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <NativeSelect
        aria-label="List"
        className="flex-[1_1_150px]"
        value={filters.listId ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            listId: event.target.value ? Number(event.target.value) : undefined,
          })
        }
      >
        <option value="">All lists</option>
        {(lists.data?.items ?? []).map((list) => (
          <option key={list.id} value={list.id}>
            {list.name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Tag"
        className="flex-[1_1_150px]"
        value={filters.tagId ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            tagId: event.target.value ? Number(event.target.value) : undefined,
          })
        }
      >
        <option value="">All tags</option>
        {(tags.data?.items ?? []).map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Status"
        className="flex-[1_1_150px]"
        value={filters.status ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            status: (event.target.value || undefined) as ContactFilters["status"],
          })
        }
      >
        <option value="">Any status</option>
        <option value="subscribed">Subscribed</option>
        <option value="unsubscribed">Unsubscribed</option>
        <option value="suppressed">Suppressed</option>
      </NativeSelect>
    </form>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const subscribedLists = contact.lists.filter((list) => list.status === "subscribed").length;
  const leftLists = contact.lists.length - subscribedLists;
  return (
    <TableRow data-testid="contact-row" className="hover:bg-muted/60">
      <TableCell className="max-w-[280px]">
        <Link
          to="/contacts/$contactId"
          params={{ contactId: String(contact.id) }}
          className="flex min-w-0 flex-col gap-0.5 hover:underline"
        >
          <span className="truncate font-medium">{contact.email}</span>
          {name ? <span className="truncate text-xs text-muted-foreground">{name}</span> : null}
        </Link>
      </TableCell>
      <TableCell>
        <StatusPill status={contact.status} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {CONSENT[contact.consentBasis].label}
      </TableCell>
      <TableCell>
        <div className="flex max-w-[220px] flex-wrap gap-1">
          {contact.tags.slice(0, 3).map((tag) => (
            <Pill key={tag.id} tone="lavender">
              {tag.name}
            </Pill>
          ))}
          {contact.tags.length > 3 ? (
            <span className="figure text-xs text-muted-foreground">+{contact.tags.length - 3}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="figure">{subscribedLists}</span>
        {leftLists > 0 ? (
          <span className="text-xs text-muted-foreground">
            {" "}
            · <span className="figure">{leftLists}</span> left
          </span>
        ) : null}
      </TableCell>
      <TableCell className="figure whitespace-nowrap text-muted-foreground">
        {formatDate(contact.createdAt)}
      </TableCell>
    </TableRow>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  filters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: ContactFilters;
}) {
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/exports", {
          body: Object.fromEntries(
            Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
          ),
        }),
      ),
  });
  const filtered = Object.values(filters).some((value) => value !== undefined && value !== "");
  const result = create.data;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader
          title="Export contacts"
          description={
            filtered
              ? "The CSV holds the contacts that match the current filters."
              : "The CSV holds every contact in this workspace."
          }
        />
        <FormError message={errorText(create.error)} />
        {result ? (
          <div className="flex flex-col gap-1 rounded-xl border border-border p-4">
            <span className="font-medium">{result.filename}</span>
            <span className="text-xs text-muted-foreground">
              <Figure value={result.rowCount} /> contacts · {formatBytes(result.sizeBytes)} · The
              link expires {formatDateTime(result.expiresAt)}.
            </span>
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">
            The file includes status, consent, tags, lists, and custom fields. The download link
            works for 24 hours. Cells that a spreadsheet could run as a formula start with a quote.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {result?.downloadUrl ? (
            <Button asChild>
              <a href={result.downloadUrl} download={result.filename}>
                <DownloadIcon className="size-3.5" aria-hidden="true" />
                Download CSV
              </a>
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} pending={create.isPending}>
              Create export
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContactsPage({
  filters,
  onFiltersChange,
}: {
  filters: ContactFilters;
  onFiltersChange: (filters: ContactFilters) => void;
}) {
  const { current } = useCurrentWorkspace();
  // The previous results stay while a new search loads, so the table does not flash.
  const contacts = useInfiniteQuery({
    ...contactsQuery(current.id, filters),
    placeholderData: keepPreviousData,
  });
  const matching = useQuery({
    ...contactCountsQuery(current.id, filters),
    placeholderData: keepPreviousData,
  });
  const [exporting, setExporting] = useState(false);
  const items = contacts.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Object.values(filters).some((value) => value !== undefined && value !== "");
  const empty = !filtered && contacts.isSuccess && items.length === 0;

  return (
    <div className="flex flex-col gap-10">
      <PageTop
        title="Contacts"
        description="Your audience, with lists, tags, and consent."
        actions={
          <>
            <Button variant="outline" onClick={() => setExporting(true)} disabled={empty}>
              <DownloadIcon className="size-3.5" aria-hidden="true" />
              Export
            </Button>
            <Button asChild>
              <Link to="/contacts/import">
                <UploadIcon className="size-3.5" aria-hidden="true" />
                Import CSV
              </Link>
            </Button>
          </>
        }
      />
      <StatStrip />
      <div className="flex flex-col gap-4">
        <ContactsNav />
        {empty ? (
          <EmptyState
            icon={UsersIcon}
            title="No contacts yet"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/contacts/import">Import a CSV</Link>
              </Button>
            }
          >
            Upload a CSV, map the columns, and set the consent basis. Apps can also add contacts
            through the API.
          </EmptyState>
        ) : (
          <>
            <Filters filters={filters} onChange={onFiltersChange} />
            <div className="flex min-h-[18px] items-center gap-3">
              <div className="text-xs text-muted-foreground" aria-live="polite">
                {matching.data ? (
                  <>
                    <Figure value={matching.data.matching} />{" "}
                    {matching.data.matching === 1 ? "contact" : "contacts"}
                    {filtered ? " match the filters" : ""}
                  </>
                ) : (
                  " "
                )}
              </div>
              {/* The old rows stay while new filters load. This note says they are updating. */}
              <Refreshing active={contacts.isPlaceholderData && contacts.isFetching} />
            </div>
            {contacts.isError ? (
              <p role="alert" className="m-0 text-[13px] text-muted-foreground">
                The contacts did not load. {errorText(contacts.error)}
              </p>
            ) : contacts.isPending ? (
              <TableSkeleton label="Loading the contacts" rows={6} columns={6} />
            ) : items.length === 0 ? (
              <EmptyState icon={SearchIcon} title="No contacts match">
                Change or clear the filters.
              </EmptyState>
            ) : (
              <div
                className={cn(
                  "transition-opacity duration-(--duration-enter)",
                  contacts.isPlaceholderData && contacts.isFetching && "opacity-60",
                )}
              >
                <Table aria-label="Contacts">
                  <thead>
                    <tr>
                      <TableHead>Contact</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Consent</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead>Lists</TableHead>
                      <TableHead>Added</TableHead>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((contact) => (
                      <ContactRow key={contact.id} contact={contact} />
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            {contacts.hasNextPage ? (
              <div>
                <Button
                  variant="outline"
                  onClick={() => void contacts.fetchNextPage()}
                  pending={contacts.isFetchingNextPage}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <ExportDialog open={exporting} onOpenChange={setExporting} filters={filters} />
    </div>
  );
}
