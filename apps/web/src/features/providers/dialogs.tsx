import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { connectionQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { type Connection, type ConnectionDetail, CopyValue, Note, type Provider } from "./shared";

// The connect flow (one field where the provider allows, KTD13), the manual webhook
// steps, and the transactional-only warning (R62).

export function ConnectDialog({
  provider,
  onOpenChange,
  onConnected,
}: {
  provider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onConnected: (connection: ConnectionDetail) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const connect = useMutation({
    mutationFn: (credentials: Record<string, string>) =>
      unwrap(api.POST("/connections", { body: { provider: provider?.id ?? "", credentials } })),
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      onConnected(connection);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credentials: Record<string, string> = {};
    for (const field of provider?.fields ?? []) {
      const value = String(data.get(field.name) ?? "").trim();
      if (value) credentials[field.name] = value;
    }
    connect.mutate(credentials);
  }

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) connect.reset();
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-[500px]">
        <DialogHeader
          title={`Connect ${provider?.name ?? ""}`}
          description={
            provider?.autoWebhook
              ? "Envelopen checks the key, then creates the webhook for bounces and complaints."
              : "Envelopen checks the key. You set up events by hand afterwards."
          }
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit} autoComplete="off">
          <FormError message={errorText(connect.error)} />
          {provider?.policy === "transactional-only" ? (
            <Note tone="salmon" title="Transactional-only provider">
              {provider.policyWarning} Owner alerts send through it right away. Campaigns need you
              to accept this warning after you connect.
            </Note>
          ) : null}
          {provider?.requiresWorkersPaid ? (
            <Note tone="lavender">This provider needs the Workers Paid plan.</Note>
          ) : null}
          {(provider?.fields ?? []).map((field) => {
            const id = `field-${field.name}`;
            return (
              <Field
                key={field.name}
                id={id}
                label={field.required ? field.label : `${field.label} (optional)`}
                hint={field.hint ?? undefined}
              >
                <Input
                  id={id}
                  name={field.name}
                  type={field.secret ? "password" : "text"}
                  required={field.required}
                  placeholder={field.placeholder ?? undefined}
                  pattern={field.pattern ?? undefined}
                  aria-describedby={field.hint ? `${id}-hint` : undefined}
                  className={field.secret ? "font-mono text-[12.5px]" : undefined}
                  spellCheck={false}
                />
              </Field>
            );
          })}
          <DialogFooter>
            {provider ? (
              <Button asChild variant="ghost">
                <a href={provider.docsUrl} target="_blank" rel="noreferrer">
                  Provider docs
                  <ArrowUpRightIcon className="size-3" aria-hidden="true" />
                </a>
              </Button>
            ) : null}
            <Button type="submit" pending={connect.isPending}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The webhook URL, the secret, and the steps for a manual setup. */
export function WebhookDialog({
  connectionId,
  onOpenChange,
}: {
  connectionId: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const detail = useQuery({
    ...connectionQuery(current.id, connectionId ?? 0),
    enabled: connectionId !== null,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
  const retry = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST("/connections/{id}/events", { params: { path: { id } } })),
    onSuccess: invalidate,
  });
  const [secret, setSecret] = useState("");
  const saveSecret = useMutation({
    mutationFn: (input: { id: number; secret: string }) =>
      unwrap(
        api.POST("/connections/{id}/webhook-secret", {
          params: { path: { id: input.id } },
          body: { secret: input.secret },
        }),
      ),
    onSuccess: async () => {
      setSecret("");
      await invalidate();
    },
  });
  const data = detail.data;
  const webhook = data?.webhook;

  return (
    <Dialog
      open={connectionId !== null}
      onOpenChange={(open) => {
        if (!open) {
          retry.reset();
          saveSecret.reset();
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-[560px]">
        <DialogHeader
          title={data ? `${data.name} events` : "Events"}
          description={
            data?.eventsSetup === "auto"
              ? "Envelopen created the webhook. Nothing to do here."
              : "Bounces and complaints keep your list clean. Follow these steps in the provider dashboard."
          }
        />
        {detail.isError ? <FormError message={errorText(detail.error)} /> : null}
        {data && webhook ? (
          <div className="flex flex-col gap-4">
            <FormError message={errorText(retry.error) ?? errorText(saveSecret.error)} />
            {webhook.url ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Webhook URL</span>
                <CopyValue label="webhook URL" value={webhook.url} testId="webhook-url" />
              </div>
            ) : null}
            {webhook.secret ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Webhook secret</span>
                <CopyValue label="webhook secret" value={webhook.secret} testId="webhook-secret" />
              </div>
            ) : null}
            {webhook.steps.length > 0 ? (
              <ol
                className="m-0 flex flex-col gap-2 pl-5 text-[13px] leading-normal"
                data-testid="webhook-steps"
              >
                {webhook.steps.map((item) => (
                  <li key={item} className="break-words pl-1">
                    {item}
                  </li>
                ))}
              </ol>
            ) : null}
            {webhook.needsSecret ||
            (data.eventsSetup === "manual" && webhook.secretSource === "provider") ? (
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (secret.trim()) saveSecret.mutate({ id: data.id, secret: secret.trim() });
                }}
              >
                <Field
                  id="provider-secret"
                  label={
                    webhook.needsSecret
                      ? "Signing secret from the provider"
                      : "Replace the signing secret"
                  }
                  className="flex-1"
                >
                  <Input
                    id="provider-secret"
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    className="font-mono text-[12.5px]"
                    placeholder="whsec_..."
                  />
                </Field>
                <Button
                  type="submit"
                  variant="outline"
                  pending={saveSecret.isPending}
                  disabled={!secret.trim()}
                >
                  Save secret
                </Button>
              </form>
            ) : null}
            {saveSecret.isSuccess ? (
              <p role="status" className="m-0 text-xs text-muted-foreground">
                The secret is saved. Envelopen now accepts this provider's webhooks.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="h-32 rounded-xl bg-muted" />
        )}
        <DialogFooter>
          {data && data.eventsSetup === "manual" && data.webhook.secretSource !== "none" ? (
            <Button
              variant="outline"
              pending={retry.isPending}
              onClick={() => retry.mutate(data.id)}
            >
              Try automatic setup again
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** R62: the owner reads the warning and accepts it. The audit log records the acceptance. */
export function PolicyDialog({
  connection,
  onOpenChange,
}: {
  connection: Connection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [understood, setUnderstood] = useState(false);
  const accept = useMutation({
    mutationFn: (id: number) =>
      unwrap(
        api.POST("/connections/{id}/accept-policy", {
          params: { path: { id } },
          body: { accept: true },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      setUnderstood(false);
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) {
          accept.reset();
          setUnderstood(false);
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader title="Use a transactional provider for campaigns?" />
        <div className="flex flex-col gap-4">
          <FormError message={errorText(accept.error)} />
          <Note tone="salmon">
            <span className="flex gap-2">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{connection?.policyWarning}</span>
            </span>
          </Note>
          <p className="m-0 text-[13px] text-muted-foreground">
            Owner alerts send through {connection?.name} either way. The audit log records who
            accepted this warning and when.
          </p>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="policy-understood"
              checked={understood}
              onCheckedChange={(value) => setUnderstood(value === true)}
            />
            <Label htmlFor="policy-understood" className="cursor-pointer font-normal">
              I understand the risk, and I take responsibility for campaigns sent through{" "}
              {connection?.name}.
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={accept.isPending}
            disabled={!understood}
            onClick={() => connection && accept.mutate(connection.id)}
          >
            Accept the warning
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The policy pill of a provider or a connection. */
export function PolicyPill({ policy }: { policy: Provider["policy"] }) {
  return policy === "campaign" ? (
    <Pill tone="teal">Campaigns</Pill>
  ) : (
    <Pill tone="salmon">Transactional only</Pill>
  );
}
