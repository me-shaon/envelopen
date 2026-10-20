import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, DownloadIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { consentQuery, contactQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { presenceClass, usePresence } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  CONSENT,
  type ConsentBasis,
  errorText,
  formatDateTime,
  StatusPill,
  sourceLabel,
} from "./shared";

type Contact = Schemas["Contact"];

function useInvalidateContacts() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  return () => queryClient.invalidateQueries({ queryKey: ["ws", current.id, "contacts"] });
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-hairline py-2.5 last:border-b-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-[13px] break-words">{children}</dd>
    </div>
  );
}

function StateBanner({ contact }: { contact: Contact }) {
  if (contact.status === "suppressed") {
    return (
      <div
        role="status"
        className="rounded-xl bg-tone-danger px-4 py-3 text-[13px] text-tone-danger-foreground"
      >
        <strong className="font-semibold">Suppressed.</strong> Envelopen never sends to this
        address. Reason: {contact.suppressionReason?.replaceAll("_", " ")}, since{" "}
        {formatDateTime(contact.suppressedAt)}.
      </div>
    );
  }
  if (contact.status === "unsubscribed") {
    return (
      <div
        role="status"
        className="rounded-xl bg-tone-salmon px-4 py-3 text-[13px] text-tone-salmon-foreground"
      >
        <strong className="font-semibold">Unsubscribed from every list</strong> on{" "}
        {formatDateTime(contact.unsubscribedAt)} (source: {sourceLabel(contact.unsubscribeSource)}
        {contact.unsubscribeCampaignId ? `, campaign #${contact.unsubscribeCampaignId}` : ""}). The
        contact stays here for your records and gets no campaign email.
      </div>
    );
  }
  return null;
}

const tagKey = (tag: Contact["tags"][number]) => tag.id;

function TagsSection({ contact }: { contact: Contact }) {
  const invalidate = useInvalidateContacts();
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: (tag: string) =>
      unwrap(
        api.POST("/contacts/{id}/tags", {
          params: { path: { id: contact.id } },
          body: { tags: [tag] },
        }),
      ),
    // The new tag shows in the row at once, so there is no toast.
    onSuccess: async () => {
      setName("");
      await invalidate();
    },
  });
  // Removing a tag is easy to reverse, so it asks nothing and offers Undo instead.
  const restore = useMutation({
    mutationFn: (tag: string) =>
      unwrap(
        api.POST("/contacts/{id}/tags", {
          params: { path: { id: contact.id } },
          body: { tags: [tag] },
        }),
      ),
    onSuccess: invalidate,
    // The Undo button was in a toast that is gone, so the error is a toast too.
    onError: (error, tag) =>
      toast.error(`Tag "${tag}" was not added back. ${errorText(error)}`, {
        retry: () => restore.mutate(tag),
      }),
  });
  const remove = useMutation({
    mutationFn: (tag: { id: number; name: string }) =>
      unwrap(
        api.DELETE("/contacts/{id}/tags/{tagId}", {
          params: { path: { id: contact.id, tagId: tag.id } },
        }),
      ),
    onSuccess: async (_data, tag) => {
      await invalidate();
      toast.undo(`Tag "${tag.name}" removed from ${contact.email}.`, () =>
        restore.mutate(tag.name),
      );
    },
  });
  // A new tag fades in. A removed tag fades out before it leaves the row.
  const tags = usePresence(contact.tags, tagKey);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  }

  return (
    <section aria-labelledby="tags-title" className="flex flex-col gap-3">
      <SectionHeader id="tags-title" title="Tags" />
      <FormError message={errorText(add.error ?? remove.error)} />
      {/* Wider gaps below sm, so the 44 px hit areas of the x buttons do not overlap. */}
      <div className="flex flex-wrap gap-1.5 max-sm:gap-3">
        {tags.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">No tags.</span>
        ) : (
          tags.map(({ key, item: tag, state }) => (
            <Pill key={key} tone="lavender" className={cn("pr-1", presenceClass(state))}>
              {tag.name}
              {/* The x stays 16 px. Below sm, a 44 px hit area centers on it for touch. */}
              <button
                type="button"
                className="relative inline-flex size-4 items-center justify-center rounded-full transition-colors duration-(--duration-press) before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] not-disabled:hover:bg-black/10 sm:before:hidden dark:not-disabled:hover:bg-white/10"
                aria-label={`Remove tag ${tag.name}`}
                disabled={state === "exit" || (remove.isPending && remove.variables?.id === tag.id)}
                onClick={() => remove.mutate({ id: tag.id, name: tag.name })}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </Pill>
          ))
        )}
      </div>
      <form className="flex max-w-[360px] gap-2" onSubmit={onSubmit}>
        <Input
          aria-label="New tag"
          placeholder="Add a tag"
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="outline" pending={add.isPending} disabled={!name.trim()}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Add
        </Button>
      </form>
    </section>
  );
}

function ConsentDialog({
  contact,
  open,
  onOpenChange,
}: {
  contact: Contact;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateContacts();
  const [basis, setBasis] = useState<ConsentBasis>(contact.consentBasis);
  const record = useMutation({
    mutationFn: (input: { basis: ConsentBasis; note: string }) =>
      unwrap(
        api.POST("/contacts/{id}/consent", {
          params: { path: { id: contact.id } },
          body: { basis: input.basis, ...(input.note ? { note: input.note } : {}) },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
      toast("Consent recorded.");
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") ?? "").trim();
    record.mutate({ basis, note });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) record.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          title="Record consent"
          description="The change is added to the consent history. Earlier entries stay."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(record.error)} />
          <RadioGroup value={basis} onValueChange={(value) => setBasis(value as ConsentBasis)}>
            {(Object.keys(CONSENT) as ConsentBasis[]).map((key) => (
              <div
                key={key}
                className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
              >
                <RadioGroupItem id={`record-${key}`} value={key} />
                <Label htmlFor={`record-${key}`} className="flex cursor-pointer flex-col">
                  <span>{CONSENT[key].label}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {CONSENT[key].detail}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
          <Field id="consent-note" label="Note" hint="For example, where the consent comes from.">
            <Textarea id="consent-note" name="note" maxLength={500} className="min-h-16" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              pending={record.isPending}
              disabled={basis === contact.consentBasis}
            >
              Record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConsentHistory({ contact }: { contact: Contact }) {
  const { current } = useCurrentWorkspace();
  const history = useQuery(consentQuery(current.id, contact.id));
  const [recording, setRecording] = useState(false);
  return (
    <section aria-labelledby="consent-title" className="flex flex-col gap-4">
      <SectionHeader
        id="consent-title"
        title="Consent history"
        aside={
          <Button variant="ghost" size="sm" onClick={() => setRecording(true)}>
            Record consent
          </Button>
        }
      />
      {history.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          The history did not load.
        </p>
      ) : history.isPending ? (
        <LoadingRegion label="Loading the consent history" className="flex flex-col gap-4">
          {["w-28", "w-24"].map((width) => (
            <div key={width} className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
              <span className="mt-[5px] size-2 rounded-full bg-track" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className={`h-3.5 rounded-sm ${width}`} />
                <Skeleton className="h-3 w-40 rounded-sm" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Consent events">
          {(history.data?.items ?? []).map((event, index) => (
            <li key={event.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-3">
              <span
                className={`mt-[5px] size-2 rounded-full ${index === 0 ? "bg-chart-2" : "bg-track"}`}
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">{CONSENT[event.basis].label}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(event.createdAt)} · {sourceLabel(event.source)}
                </span>
                {event.note ? (
                  <span className="text-xs text-muted-foreground">{event.note}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      <ConsentDialog
        key={String(recording)}
        contact={contact}
        open={recording}
        onOpenChange={setRecording}
      />
    </section>
  );
}

/** Saves the export as a JSON file in the browser. */
function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke later: the browser reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The erase confirmation (R21). The owner types the address, because erase is final. */
function EraseDialog({
  contact,
  open,
  onOpenChange,
  onErased,
}: {
  contact: Contact;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onErased: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const erase = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/contacts/{id}/erase", {
          params: { path: { id: contact.id } },
          body: { confirm: typed },
        }),
      ),
    onSuccess: onErased,
  });
  const matches = typed.trim().toLowerCase() === contact.email;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (matches) erase.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped("");
          erase.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          title="Erase this contact?"
          description="Use this for a deletion request under GDPR. You cannot undo it."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(erase.error)} />
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
            <li>
              Envelopen removes the contact, its tags, lists, custom fields, consent history, opens,
              clicks, and provider events.
            </li>
            <li>Campaign totals stay, without the person.</li>
            <li>
              A hash of the address stays on the suppression list, so an import cannot add the
              address back.
            </li>
          </ul>
          <Field
            id="erase-confirm"
            label={`Type ${contact.email} to confirm`}
            hint="Export the data first if the person asked for a copy."
          >
            <Input
              id="erase-confirm"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-describedby="erase-confirm-hint"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              pending={erase.isPending}
              disabled={!matches}
            >
              Erase contact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContactDetailPage({ contactId }: { contactId: number }) {
  const { current } = useCurrentWorkspace();
  const navigate = useNavigate();
  const invalidate = useInvalidateContacts();
  const contact = useQuery(contactQuery(current.id, contactId));
  const [confirm, setConfirm] = useState<"unsubscribe" | "erase" | null>(null);

  const unsubscribe = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/contacts/{id}", {
          params: { path: { id: contactId } },
          body: { unsubscribe: true },
        }),
      ),
    onSuccess: async () => {
      setConfirm(null);
      await invalidate();
      toast("Contact unsubscribed from all lists.");
    },
  });
  const exportData = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/contacts/{id}/export", { params: { path: { id: contactId } } })),
    onSuccess: (data) => {
      downloadJson(`contact-${contactId}.json`, data);
      toast("The contact data is downloading as JSON.");
    },
  });

  const back = (
    <Link
      to="/contacts"
      className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Contacts
    </Link>
  );

  if (contact.isError) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          {errorText(contact.error)}
        </p>
      </div>
    );
  }
  const data = contact.data;
  if (!data) {
    return (
      <LoadingRegion label="Loading the contact" className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          {back}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-[30px] w-[280px] max-w-[70%]" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="h-4 w-32 rounded-sm" />
          </div>
        </div>
        <div className="flex flex-wrap gap-12">
          <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-2">
            <Skeleton className="h-4 w-16 rounded-sm" />
            {["w-[46%]", "w-[30%]", "w-[38%]", "w-[34%]"].map((width) => (
              <div
                key={width}
                className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-hairline py-3 last:border-b-0"
              >
                <Skeleton className="h-3 w-20 rounded-sm" />
                <Skeleton className={`h-3 rounded-sm ${width}`} />
              </div>
            ))}
          </div>
          <div className="flex max-w-[320px] flex-[1_1_260px] flex-col gap-4 pt-1">
            <Skeleton className="h-4 w-28 rounded-sm" />
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        </div>
      </LoadingRegion>
    );
  }

  const name = [data.firstName, data.lastName].filter(Boolean).join(" ");
  const fields = Object.entries(data.fields);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        {back}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="m-0 truncate text-[26px] leading-[1.15] font-semibold tracking-[-0.03em]">
                {data.email}
              </h1>
              <StatusPill status={data.status} />
            </div>
            <p className="m-0 text-[15px] text-muted-foreground">{name || "No name"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.unsubscribedAt === null ? (
              <Button variant="outline" onClick={() => setConfirm("unsubscribe")}>
                Unsubscribe from all
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => exportData.mutate()}
              pending={exportData.isPending}
            >
              <DownloadIcon className="size-3.5" aria-hidden="true" />
              Export data
            </Button>
          </div>
        </div>
        <FormError message={errorText(exportData.error)} />
        <StateBanner contact={data} />
      </div>

      <div className="flex flex-wrap gap-12">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-10">
          <section aria-labelledby="details-title" className="flex flex-col gap-2">
            <SectionHeader id="details-title" title="Details" />
            <dl className="m-0 flex flex-col">
              <Detail label="Consent basis">
                {CONSENT[data.consentBasis].label}
                <span className="text-muted-foreground">
                  {" "}
                  · {sourceLabel(data.consentSource)}, {formatDateTime(data.consentAt)}
                </span>
              </Detail>
              <Detail label="Source">{sourceLabel(data.source)}</Detail>
              <Detail label="Added">
                <span className="figure">{formatDateTime(data.createdAt)}</span>
              </Detail>
              <Detail label="Updated">
                <span className="figure">{formatDateTime(data.updatedAt)}</span>
              </Detail>
              {fields.map(([key, value]) => (
                <Detail key={key} label={key}>
                  {value ?? <span className="text-muted-foreground">Empty</span>}
                </Detail>
              ))}
            </dl>
          </section>

          <section aria-labelledby="lists-title" className="flex flex-col gap-4">
            <SectionHeader id="lists-title" title="List memberships" />
            {data.lists.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">Not on any list.</p>
            ) : (
              <Table aria-label="List memberships">
                <thead>
                  <tr>
                    <TableHead>List</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Since</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {data.lists.map((list) => (
                    <TableRow key={list.listId}>
                      <TableCell className="font-medium">{list.listName}</TableCell>
                      <TableCell>
                        <StatusPill status={list.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {sourceLabel(list.source)}
                        {list.campaignId ? ` · campaign #${list.campaignId}` : ""}
                      </TableCell>
                      <TableCell className="figure whitespace-nowrap text-muted-foreground">
                        {formatDateTime(list.at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <TagsSection contact={data} />
        </div>

        <aside aria-label="Consent" className="flex max-w-[320px] flex-[1_1_260px] flex-col pt-1">
          <ConsentHistory contact={data} />
        </aside>
      </div>

      <section
        aria-labelledby="danger-title"
        className="flex flex-col gap-4 border-t border-hairline pt-10"
      >
        <SectionHeader id="danger-title" title="Danger zone" />
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border px-4 py-3.5">
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
            <span className="text-[13px] font-medium">Erase this contact</span>
            <span className="text-xs text-muted-foreground">
              Use this for a GDPR deletion request. It removes the person and their data. You cannot
              undo it.
            </span>
          </div>
          <Button variant="destructive-outline" onClick={() => setConfirm("erase")}>
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Erase contact
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirm === "unsubscribe"}
        onOpenChange={(open) => {
          if (open) return;
          setConfirm(null);
          unsubscribe.reset();
        }}
        title={`Unsubscribe ${data.email}?`}
        description="The contact leaves every list and gets no campaign email. The contact stays visible. Only the contact can resubscribe."
        confirmLabel="Unsubscribe from all"
        pending={unsubscribe.isPending}
        error={errorText(unsubscribe.error)}
        onConfirm={() => unsubscribe.mutate()}
      />
      <EraseDialog
        contact={data}
        open={confirm === "erase"}
        onOpenChange={(open) => setConfirm(open ? "erase" : null)}
        onErased={async () => {
          setConfirm(null);
          await navigate({ to: "/contacts" });
          await invalidate();
          toast(`Contact ${data.email} erased.`);
        }}
      />
    </div>
  );
}
