import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, GlobeIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { domainQuery, domainsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { LoadingRegion, Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, formatDateTime, PageTop } from "@/features/contacts/shared";
import {
  CHECK_STATUS,
  type CheckStatus,
  ConnectionsNav,
  CopyValue,
  DOMAIN_STATUS,
  type SendingDomain,
} from "./shared";

// Sending domains (R12, R13): add the domain, copy the DNS records, and check them.
// The checks run over DNS over HTTPS. A domain is verified when SPF, DKIM, and DMARC pass.

const CHECKS = [
  ["spf", "SPF"],
  ["dkim", "DKIM"],
  ["dmarc", "DMARC"],
  ["tracking", "Tracking"],
] as const;

const PURPOSE: Record<SendingDomain["records"][number]["purpose"], string> = {
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  return_path: "Return path",
  tracking: "Tracking",
};

function CheckPill({ status, label }: { status: CheckStatus; label: string }) {
  const item = CHECK_STATUS[status];
  return (
    <Pill tone={item.tone}>
      <span className="font-mono text-[10.5px]">{label}</span>
      <span className="sr-only">: {item.label}</span>
    </Pill>
  );
}

function AddDomainForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { current } = useCurrentWorkspace();
  const [domain, setDomain] = useState("");
  const [tracking, setTracking] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/domains", {
          body: {
            domain: domain.trim(),
            ...(tracking.trim() ? { trackingDomain: tracking.trim() } : {}),
          },
        }),
      ),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      await navigate({
        to: "/connections/domains/$domainId",
        params: { domainId: String(created.id) },
      });
    },
  });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (domain.trim()) create.mutate();
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <FormError message={errorText(create.error)} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="new-domain" label="Sending domain" className="min-w-[220px] flex-1">
          <Input
            id="new-domain"
            value={domain}
            placeholder="mail.example.com"
            onChange={(event) => setDomain(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <Field
          id="new-tracking"
          label="Tracking domain (optional)"
          className="min-w-[220px] flex-1"
        >
          <Input
            id="new-tracking"
            value={tracking}
            placeholder="track.example.com"
            onChange={(event) => setTracking(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <Button type="submit" pending={create.isPending} disabled={!domain.trim()}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          {create.isPending ? "Checking..." : "Add domain"}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        Add the domain to your provider first, so Envelopen can list its exact records. The tracking
        domain must be in the same Cloudflare account as this Worker.
      </p>
    </form>
  );
}

export function DomainsPage() {
  const { current } = useCurrentWorkspace();
  const domains = useQuery(domainsQuery(current.id));
  const items = domains.data?.items ?? [];
  return (
    <div className="flex flex-col gap-10">
      <PageTop
        title="Connections"
        description="The email provider that sends your email, and the domains it sends from."
      />
      <div className="flex flex-col gap-8">
        <ConnectionsNav />
        <AddDomainForm />
        <section aria-labelledby="domains-title" className="flex flex-col gap-4">
          <SectionHeader
            id="domains-title"
            title="Sending domains"
            aside="SPF, DKIM, and DMARC must pass"
          />
          {domains.isError ? (
            <p role="alert" className="m-0 text-[13px] text-muted-foreground">
              {errorText(domains.error)}
            </p>
          ) : domains.isPending ? (
            <TableSkeleton label="Loading the sending domains" rows={2} columns={4} />
          ) : items.length === 0 ? (
            <EmptyState icon={GlobeIcon} title="No sending domain yet">
              Add the domain that your emails come from. Envelopen lists the DNS records to copy and
              checks them for you.
            </EmptyState>
          ) : (
            <Table aria-label="Sending domains">
              <thead>
                <tr>
                  <TableHead>Domain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Last check</TableHead>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <TableRow key={item.id} data-testid="domain-row">
                    <TableCell>
                      <Link
                        to="/connections/domains/$domainId"
                        params={{ domainId: String(item.id) }}
                        className="font-medium hover:underline"
                      >
                        {item.domain}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Pill tone={DOMAIN_STATUS[item.status].tone}>
                        {DOMAIN_STATUS[item.status].label}
                      </Pill>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {CHECKS.map(([key, label]) => (
                          <CheckPill key={key} status={item[key].status} label={label} />
                        ))}
                      </span>
                    </TableCell>
                    <TableCell className="figure whitespace-nowrap text-muted-foreground">
                      {formatDateTime(item.lastCheckedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}

function SettingsForm({ domain }: { domain: SendingDomain }) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [tracking, setTracking] = useState(domain.trackingDomain ?? "");
  const [selectors, setSelectors] = useState(domain.dkimSelectors.join(", "));
  const update = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/domains/{id}", {
          params: { path: { id: domain.id } },
          body: {
            trackingDomain: tracking.trim() || null,
            dkimSelectors: selectors
              .split(/[\s,]+/)
              .map((item) => item.trim())
              .filter(Boolean),
          },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      toast("Domain settings saved. The records were checked again.");
    },
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate();
      }}
    >
      <FormError message={errorText(update.error)} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="tracking-domain" label="Tracking domain" className="min-w-[200px] flex-1">
          <Input
            id="tracking-domain"
            value={tracking}
            placeholder="track.example.com"
            onChange={(event) => setTracking(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <Field id="dkim-selectors" label="DKIM selectors" className="min-w-[200px] flex-1">
          <Input
            id="dkim-selectors"
            value={selectors}
            placeholder="resend, 20261019pm"
            onChange={(event) => setSelectors(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <Button type="submit" variant="outline" pending={update.isPending}>
          Save and check
        </Button>
      </div>
    </form>
  );
}

export function DomainDetailPage({ domainId }: { domainId: number }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { current } = useCurrentWorkspace();
  const domain = useQuery(domainQuery(current.id, domainId));
  const [removing, setRemoving] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
  const check = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/domains/{id}/check", { params: { path: { id: domainId } } })),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/domains/{id}", { params: { path: { id: domainId } } })),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/connections/domains" });
    },
  });
  const data = domain.data;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <Link
          to="/connections/domains"
          className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Sending domains
        </Link>
        <PageTop
          title={data?.domain ?? "Domain"}
          description={
            data ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Pill tone={DOMAIN_STATUS[data.status].tone}>
                  {DOMAIN_STATUS[data.status].label}
                </Pill>
                <span>Last checked {formatDateTime(data.lastCheckedAt)}</span>
              </span>
            ) : (
              <Skeleton className="mt-1 h-4 w-56 rounded-sm" />
            )
          }
          actions={
            data ? (
              <>
                <Button variant="outline" pending={check.isPending} onClick={() => check.mutate()}>
                  <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                  Check again
                </Button>
                <Button variant="destructive-ghost" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              </>
            ) : null
          }
        />
      </div>
      {domain.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          {errorText(domain.error)}
        </p>
      ) : !data ? (
        <LoadingRegion label="Loading the domain" className="flex flex-col gap-6">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border">
            {["spf", "dkim", "dmarc", "tracking"].map((key) => (
              <div key={key} className="flex flex-col gap-2 bg-background p-4">
                <Skeleton className="h-3 w-12 rounded-sm" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
          <Skeleton className="h-[180px] rounded-xl" />
        </LoadingRegion>
      ) : (
        <>
          <FormError message={errorText(check.error)} />
          <section aria-label="DNS checks">
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(170px,1fr))] overflow-hidden rounded-xl border border-border p-0">
              {CHECKS.map(([key, label], index) => {
                const item = data[key];
                const status = CHECK_STATUS[item.status];
                return (
                  <li
                    key={key}
                    className={
                      index > 0
                        ? "flex flex-col gap-2 border-l border-border p-[18px]"
                        : "flex flex-col gap-2 p-[18px]"
                    }
                    data-testid={`check-${key}`}
                    data-status={item.status}
                  >
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </span>
                    <span className="text-xs leading-normal break-words text-muted-foreground">
                      {item.detail ?? "Not checked yet."}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="records-title" className="flex flex-col gap-4">
            <SectionHeader
              id="records-title"
              title="DNS records to add"
              aside="Add them at your DNS host, then check again"
            />
            <Table aria-label="DNS records">
              <thead>
                <tr>
                  <TableHead>Record</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Value</TableHead>
                </tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <TableRow
                    key={`${record.purpose}-${record.host}-${record.type}`}
                    data-testid="dns-record"
                  >
                    <TableCell className="whitespace-nowrap font-medium">
                      {PURPOSE[record.purpose]}
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">{record.type}</TableCell>
                    <TableCell className="max-w-[260px]">
                      <CopyValue label={`${PURPOSE[record.purpose]} host`} value={record.host} />
                    </TableCell>
                    <TableCell className="max-w-[340px]">
                      <div className="flex flex-col gap-1">
                        {record.value ? (
                          <CopyValue
                            label={`${PURPOSE[record.purpose]} value`}
                            value={record.value}
                          />
                        ) : null}
                        {record.note ? (
                          <span className="text-xs text-muted-foreground">{record.note}</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </section>

          <section aria-labelledby="domain-settings-title" className="flex flex-col gap-4">
            <SectionHeader id="domain-settings-title" title="Settings" />
            <SettingsForm key={data.id} domain={data} />
          </section>
        </>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${data?.domain ?? "this domain"}?`}
        description={
          errorText(remove.error) ??
          "Envelopen stops using the domain. Your DNS records and the domain at your provider stay as they are."
        }
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
