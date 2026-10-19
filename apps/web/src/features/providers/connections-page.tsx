import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  PlugIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  WebhookIcon,
} from "lucide-react";
import { useState } from "react";
import { api, unwrap } from "@/api/client";
import { connectionsQuery, providersQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, formatDateTime, PageTop } from "@/features/contacts/shared";
import { ConnectDialog, PolicyDialog, PolicyPill, WebhookDialog } from "./dialogs";
import {
  CONNECTION_STATUS,
  type Connection,
  ConnectionsNav,
  EVENTS_SETUP,
  Note,
  type Provider,
} from "./shared";
import { TestSendSection } from "./test-send";

// The Connections page (R9, R10, R62, R63): the workspace's provider connections, the
// providers it can add, and test sends. One connection sends all email of the workspace.

function ConnectionCard({
  connection,
  onWebhook,
  onAccept,
  onRemove,
}: {
  connection: Connection;
  onWebhook: (connection: Connection) => void;
  onAccept: (connection: Connection) => void;
  onRemove: (connection: Connection) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
  const check = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/connections/{id}/test", { params: { path: { id: connection.id } } })),
    onSuccess: invalidate,
  });
  const select = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/connections/{id}/select", { params: { path: { id: connection.id } } })),
    onSuccess: invalidate,
  });
  const status = CONNECTION_STATUS[connection.status];
  const needsAcceptance =
    connection.policy === "transactional-only" && connection.policyWarningAcceptedAt === null;

  return (
    <li
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
      data-testid="connection-card"
      data-provider={connection.provider}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{connection.name}</h3>
            <Pill tone={status.tone}>
              <span className="sr-only">Status: </span>
              {status.label}
            </Pill>
            {connection.selected ? <Pill tone="lavender">Sends your email</Pill> : null}
            <PolicyPill policy={connection.policy} />
          </div>
          <span className="text-[13px] text-muted-foreground">
            {[connection.accountLabel, `Checked ${formatDateTime(connection.lastCheckedAt)}`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {connection.selected ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={select.isPending}
              onClick={() => select.mutate()}
            >
              Use for sending
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCwIcon className="size-3" aria-hidden="true" />
            {check.isPending ? "Checking..." : "Check"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRemove(connection)}>
            Remove<span className="sr-only"> {connection.name}</span>
          </Button>
        </div>
      </div>

      {errorText(check.error) || errorText(select.error) ? (
        <Note tone="danger">{errorText(check.error) ?? errorText(select.error)}</Note>
      ) : null}
      {connection.status === "error" && connection.statusDetail ? (
        <Note tone="danger" title="The provider reports a problem" testId="connection-error">
          {connection.statusDetail}
        </Note>
      ) : null}
      {connection.warnings.map((warning) => (
        <Note key={warning} tone="salmon" testId="connection-warning">
          {warning}
        </Note>
      ))}
      {needsAcceptance ? (
        <Note
          tone="salmon"
          title="Campaigns are blocked on this connection"
          testId="policy-warning"
        >
          <span className="flex flex-col items-start gap-2">
            <span>{connection.policyWarning}</span>
            <span>Owner alerts still send. Accept the warning to send campaigns through it.</span>
            <Button size="sm" variant="outline" onClick={() => onAccept(connection)}>
              Review the warning
            </Button>
          </span>
        </Note>
      ) : connection.policy === "transactional-only" ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          You accepted the transactional-only warning on{" "}
          {formatDateTime(connection.policyWarningAcceptedAt)}.
        </span>
      ) : null}
      {connection.requiresWorkersPaid ? (
        <span className="text-xs text-muted-foreground">Needs the Workers Paid plan.</span>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <WebhookIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {EVENTS_SETUP[connection.eventsSetup]}
        </span>
        {connection.eventsSetup !== "auto" ? (
          <Button
            size="sm"
            variant={connection.eventsSetup === "manual" ? "default" : "outline"}
            onClick={() => onWebhook(connection)}
          >
            {connection.eventsSetup === "manual" ? "Set up the webhook" : "How events work"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ProviderCard({
  provider,
  onConnect,
}: {
  provider: Provider;
  onConnect: (provider: Provider) => void;
}) {
  return (
    <li
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      data-testid="provider-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-[14px] font-semibold tracking-[-0.01em]">{provider.name}</h3>
        <PolicyPill policy={provider.policy} />
        {provider.requiresWorkersPaid ? <Pill tone="neutral">Workers Paid</Pill> : null}
      </div>
      <p className="m-0 text-[13px] leading-normal text-muted-foreground">{provider.notes[0]}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-xs text-muted-foreground">
          {provider.fields.filter((field) => field.required).length === 1
            ? "One field"
            : `${provider.fields.filter((field) => field.required).length} fields`}
          {provider.autoWebhook ? " · Automatic webhook" : " · Manual events"}
        </span>
        <Button size="sm" variant="outline" onClick={() => onConnect(provider)}>
          Connect<span className="sr-only"> {provider.name}</span>
        </Button>
      </div>
    </li>
  );
}

export function ConnectionsPage() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const connections = useQuery(connectionsQuery(current.id));
  const providers = useQuery(providersQuery);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [webhookFor, setWebhookFor] = useState<number | null>(null);
  const [accepting, setAccepting] = useState<Connection | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE("/connections/{id}", { params: { path: { id } } })),
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
    },
  });
  const items = connections.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop
        title="Connections"
        description="The email provider that sends your email, and the domains it sends from."
      />
      <div className="flex flex-col gap-8">
        <ConnectionsNav />
        <section aria-labelledby="connected-title" className="flex flex-col gap-4">
          <SectionHeader
            id="connected-title"
            title="Connected providers"
            aside="One connection sends your campaigns and owner alerts"
          />
          {connections.isError ? (
            <p role="alert" className="m-0 text-[13px] text-muted-foreground">
              {errorText(connections.error)}
            </p>
          ) : connections.isPending ? (
            <div className="h-40 rounded-xl border border-border bg-muted" />
          ) : items.length === 0 ? (
            <EmptyState icon={PlugIcon} title="No provider connected">
              Pick a provider below and paste its API key. Envelopen checks the key and sets up
              bounce and complaint events where the provider allows.
            </EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Connected providers">
              {items.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onWebhook={(item) => setWebhookFor(item.id)}
                  onAccept={setAccepting}
                  onRemove={(item) => {
                    remove.reset();
                    setRemoving(item);
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="providers-title" className="flex flex-col gap-4">
          <SectionHeader
            id="providers-title"
            title="Add a provider"
            aside="SES, Resend, and Postmark send campaigns"
          />
          {providers.isError ? (
            <p role="alert" className="m-0 text-[13px] text-muted-foreground">
              {errorText(providers.error)}
            </p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-0">
              {(providers.data?.providers ?? []).map((provider) => (
                <ProviderCard key={provider.id} provider={provider} onConnect={setConnecting} />
              ))}
            </ul>
          )}
          <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleAlertIcon className="size-3.5" aria-hidden="true" />
            Envelopen stores API keys encrypted. Nobody can read them back, not even you.
          </p>
        </section>

        <TestSendSection
          hasConnection={items.some((item) => item.selected && item.status === "active")}
        />
      </div>

      <ConnectDialog
        provider={connecting}
        onOpenChange={(open) => !open && setConnecting(null)}
        onConnected={(connection) => {
          setConnecting(null);
          if (connection.eventsSetup === "manual" || connection.webhook.needsSecret)
            setWebhookFor(connection.id);
        }}
      />
      <WebhookDialog
        connectionId={webhookFor}
        onOpenChange={(open) => !open && setWebhookFor(null)}
      />
      <PolicyDialog connection={accepting} onOpenChange={(open) => !open && setAccepting(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this connection"}?`}
        description={
          errorText(remove.error) ??
          "Envelopen deletes the stored key and removes the webhook it created. Campaigns cannot send until you connect a provider again."
        }
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}
