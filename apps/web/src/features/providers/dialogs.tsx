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
import { NativeSelect } from "@/components/ui/native-select";
import { Pill } from "@/components/ui/pill";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { PresetFields, PresetPicker, presetPayload } from "./presets";
import { type Connection, type ConnectionDetail, CopyValue, Note, type Provider } from "./shared";

// The connect flow (one field where the provider allows, KTD13; presets for SMTP, U18;
// a choice field such as the Mailgun region, U20),
// the manual webhook steps with the token rotation (Brevo, KTD13), and the policy
// warning of a transactional-only provider (R62) or a Gmail preset (R29).

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
  const [presetId, setPresetId] = useState<string | null>(null);
  const presets = provider?.presets ?? [];
  const preset = presets.find((item) => item.id === presetId) ?? presets[0] ?? null;
  const connect = useMutation({
    mutationFn: (body: { credentials: Record<string, string>; dailyCap?: number | null }) =>
      unwrap(api.POST("/connections", { body: { provider: provider?.id ?? "", ...body } })),
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
      setPresetId(null);
      onConnected(connection);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (provider && preset) {
      connect.mutate(presetPayload(provider, preset, data));
      return;
    }
    const credentials: Record<string, string> = {};
    for (const field of provider?.fields ?? []) {
      const value = String(data.get(field.name) ?? "").trim();
      if (value) credentials[field.name] = value;
    }
    connect.mutate({ credentials });
  }

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) {
          connect.reset();
          setPresetId(null);
        }
        onOpenChange(open);
      }}
    >
      {/* The SMTP presets make a long form, so the dialog scrolls on short screens. */}
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-[500px] overflow-y-auto">
        <DialogHeader
          title={`Connect ${provider?.name ?? ""}`}
          description={
            preset
              ? "Envelopen signs in to the SMTP server to check the login. It sends no email."
              : provider?.autoWebhook
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
          {provider && preset ? (
            <>
              <PresetPicker
                presets={presets}
                value={preset.id}
                onChange={(id) => {
                  connect.reset();
                  setPresetId(id);
                }}
              />
              <PresetFields key={preset.id} provider={provider} preset={preset} />
            </>
          ) : null}
          {(preset ? [] : (provider?.fields ?? [])).map((field) => {
            const id = `field-${field.name}`;
            return (
              <Field
                key={field.name}
                id={id}
                label={field.required ? field.label : `${field.label} (optional)`}
                hint={field.hint ?? undefined}
              >
                {field.options ? (
                  <NativeSelect
                    id={id}
                    name={field.name}
                    required={field.required}
                    defaultValue={field.defaultValue ?? field.options[0]?.value}
                    aria-describedby={field.hint ? `${id}-hint` : undefined}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
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
                )}
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
  const rotate = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST("/connections/{id}/webhook-secret/rotate", { params: { path: { id } } })),
    onSuccess: invalidate,
  });
  const data = detail.data;
  const webhook = data?.webhook;
  // A token in the Authorization header, not a signature (the Brevo preset of SMTP).
  const bearer = data?.provider === "smtp" && webhook?.secretSource === "envelopen";

  return (
    <Dialog
      open={connectionId !== null}
      onOpenChange={(open) => {
        if (!open) {
          retry.reset();
          saveSecret.reset();
          rotate.reset();
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-[560px] overflow-y-auto">
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
            <FormError
              message={
                errorText(retry.error) ?? errorText(saveSecret.error) ?? errorText(rotate.error)
              }
            />
            {webhook.url ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Webhook URL</span>
                <CopyValue label="webhook URL" value={webhook.url} testId="webhook-url" />
              </div>
            ) : null}
            {webhook.secret ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">
                  {bearer ? "Bearer token" : "Webhook secret"}
                </span>
                <CopyValue
                  label={bearer ? "bearer token" : "webhook secret"}
                  value={webhook.secret}
                  testId="webhook-secret"
                />
                {bearer ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      pending={rotate.isPending}
                      onClick={() => rotate.mutate(data.id)}
                    >
                      Rotate the token
                    </Button>
                    <span role="status" className="text-xs text-muted-foreground">
                      {rotate.isSuccess
                        ? "Envelopen made a new token. The old token no longer works. Update the webhook in Brevo."
                        : "Brevo sends this token in the Authorization header. The URL holds no secret."}
                    </span>
                  </div>
                ) : null}
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
          {data &&
          data.eventsSetup === "manual" &&
          data.webhook.secretSource !== "none" &&
          data.provider !== "smtp" ? (
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
      if (connection) toast(`Warning for ${connection.name} accepted.`);
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
        <DialogHeader
          title={
            connection?.policy === "campaign"
              ? `Send campaigns through ${connection.name}?`
              : "Use a transactional provider for campaigns?"
          }
        />
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
