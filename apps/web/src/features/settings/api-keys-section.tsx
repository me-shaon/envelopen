import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { apiKeyPresetsQuery, apiKeysQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ListSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { CopyValue } from "@/features/providers/shared";
import { formatDate } from "@/lib/format";

type ApiKey = Schemas["ApiKey"];
type PresetId = "enrollment_sync" | "agent_read_only" | "agent_editor" | "agent_sender";

/** The MCP endpoint of this deployment (U16). It accepts API keys only. */
function mcpEndpoint(): string {
  return `${window.location.origin}/mcp`;
}

/** A Streamable HTTP client config with the key, in the `mcpServers` shape most clients read. */
function mcpClientConfig(key: string): string {
  const config = {
    mcpServers: {
      envelopen: {
        type: "http",
        url: mcpEndpoint(),
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Agent keys read campaigns. The enrollment sync key only writes contacts. */
function isAgentKey(key: Schemas["CreatedApiKey"]): boolean {
  return key.scopes.includes("campaigns:read");
}

function AgentConfig({ apiKey }: { apiKey: Schemas["CreatedApiKey"] }) {
  const [copied, setCopied] = useState(false);
  const config = mcpClientConfig(apiKey.key);

  async function copy() {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      setCopied(false);
      toast.error("The agent config was not copied. Select the text and copy it.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Connect an agent</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy config"}
        </Button>
      </div>
      {/* Focusable, so a keyboard user can scroll the config. */}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access.
        tabIndex={0}
        aria-label="MCP client config"
        data-testid="mcp-client-config"
        className="max-h-48 overflow-auto rounded-[9px] border border-input bg-card px-3 py-2"
      >
        <pre className="m-0 font-mono text-[11.5px] leading-relaxed">{config}</pre>
      </section>
      <span className="text-xs text-muted-foreground">
        Paste it into the MCP settings of your agent. The config holds the key, so keep it private.
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "The config is copied." : ""}
      </span>
    </div>
  );
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: Schemas["CreatedApiKey"]) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const presets = useQuery({ ...apiKeyPresetsQuery, enabled: open });
  const [preset, setPreset] = useState<PresetId>("agent_read_only");

  const create = useMutation({
    mutationFn: (input: { name: string; preset: PresetId }) =>
      unwrap(api.POST("/api-keys", { body: input })),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery(current.id).queryKey });
      onOpenChange(false);
      onCreated(created);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    create.mutate({ name, preset });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          title="Create an API key"
          description={`The key works in ${current.name} only. Pick the smallest preset that fits.`}
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(create.error)} />
          <Field id="key-name" label="Name" hint="For example, the tool that uses the key.">
            <Input
              id="key-name"
              name="name"
              required
              maxLength={100}
              aria-describedby="key-name-hint"
            />
          </Field>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] font-medium">Access</legend>
            <RadioGroup value={preset} onValueChange={(value) => setPreset(value as PresetId)}>
              {(presets.data?.presets ?? []).map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
                >
                  <RadioGroupItem id={`preset-${item.id}`} value={item.id} />
                  <Label htmlFor={`preset-${item.id}`} className="flex cursor-pointer flex-col">
                    <span>{item.label}</span>
                    <span className="font-mono text-[11.5px] font-normal text-muted-foreground">
                      {item.scopes.join(", ")}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" pending={create.isPending} disabled={!presets.data}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShowKeyDialog({
  created,
  onClose,
}: {
  created: Schemas["CreatedApiKey"] | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
      toast.error("The key was not copied. Select the text and copy it.");
    }
  }

  return (
    <Dialog
      open={created !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader
          title="Copy your new key"
          description="This is the only time the key is shown. Store it in a secret manager."
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-key">{created?.name}</Label>
          <Input
            id="new-key"
            readOnly
            value={created?.key ?? ""}
            className="font-mono text-[12.5px]"
            onFocus={(event) => event.currentTarget.select()}
            data-testid="new-api-key"
          />
        </div>
        {created && isAgentKey(created) ? <AgentConfig apiKey={created} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
        <span aria-live="polite" className="sr-only">
          {copied ? "The key is copied." : ""}
        </span>
      </DialogContent>
    </Dialog>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (key: ApiKey) => void }) {
  const revoked = apiKey.revokedAt !== null;
  const expired = !revoked && apiKey.expiresAt !== null && apiKey.expiresAt <= Date.now();
  return (
    <li
      data-testid="api-key-row"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-hairline px-4 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{apiKey.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{apiKey.prefix}...</span>
          {revoked ? <Pill tone="danger">Revoked</Pill> : expired ? <Pill>Expired</Pill> : null}
        </div>
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">
          {apiKey.scopes.join(", ")}
        </span>
        <span className="text-xs text-muted-foreground">
          Created {formatDate(apiKey.createdAt)} · Last used {formatDate(apiKey.lastUsedAt)}
        </span>
      </div>
      {revoked ? null : (
        <Button variant="destructive-ghost" size="sm" onClick={() => onRevoke(apiKey)}>
          Revoke<span className="sr-only"> {apiKey.name}</span>
        </Button>
      )}
    </li>
  );
}

export function ApiKeysSection() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const keys = useQuery(apiKeysQuery(current.id));
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Schemas["CreatedApiKey"] | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = useMutation({
    mutationFn: (key: ApiKey) =>
      unwrap(api.POST("/api-keys/{id}/revoke", { params: { path: { id: key.id } } })),
    onSuccess: async (_data, key) => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery(current.id).queryKey });
      toast(`Key "${key.name}" revoked.`);
    },
  });

  const items = keys.data?.items ?? [];

  return (
    <section id="api-keys" aria-labelledby="api-keys-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="api-keys-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
            API keys
          </h2>
          <span className="text-[13px] text-muted-foreground">
            Keys for scripts and agents in {current.name}.
          </span>
        </div>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Create key
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">MCP endpoint</span>
        <CopyValue
          label="MCP endpoint"
          value={mcpEndpoint()}
          testId="mcp-endpoint"
          className="max-w-[480px]"
        />
        <span className="text-xs text-muted-foreground">
          Agents connect here with an API key from an agent preset. Sign-in sessions do not work.
        </span>
      </div>

      {keys.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          The keys did not load. Reload the page to try again.
        </p>
      ) : keys.isPending ? (
        <ListSkeleton label="Loading the API keys" rows={2} />
      ) : items.length === 0 ? (
        <EmptyState icon={KeyRoundIcon} title="No API keys in this workspace">
          Create a key to sync contacts or to connect an agent.
        </EmptyState>
      ) : (
        <ul
          className="m-0 flex list-none flex-col rounded-xl border border-border p-0"
          aria-label={`API keys in ${current.name}`}
        >
          {items.map((apiKey) => (
            <KeyRow
              key={apiKey.id}
              apiKey={apiKey}
              onRevoke={(key) => {
                revoke.reset();
                setRevoking(key);
              }}
            />
          ))}
        </ul>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={setCreated} />
      <ShowKeyDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "key"}?`}
        description="The key fails from the next request on. You cannot undo this."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        error={errorText(revoke.error)}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </section>
  );
}
