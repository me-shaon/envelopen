import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, XIcon } from "lucide-react";
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
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentWorkspace } from "@/components/workspace-context";
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
    onSuccess: async () => {
      setName("");
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (tagId: number) =>
      unwrap(
        api.DELETE("/contacts/{id}/tags/{tagId}", { params: { path: { id: contact.id, tagId } } }),
      ),
    onSuccess: invalidate,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  }

  return (
    <section aria-labelledby="tags-title" className="flex flex-col gap-3">
      <SectionHeader id="tags-title" title="Tags" />
      <FormError message={errorText(add.error ?? remove.error)} />
      <div className="flex flex-wrap gap-1.5">
        {contact.tags.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">No tags.</span>
        ) : (
          contact.tags.map((tag) => (
            <Pill key={tag.id} tone="lavender" className="pr-1">
              {tag.name}
              <button
                type="button"
                className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full hover:bg-black/10"
                aria-label={`Remove tag ${tag.name}`}
                onClick={() => remove.mutate(tag.id)}
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
        <Button type="submit" variant="outline" disabled={add.isPending || !name.trim()}>
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
            <Button type="submit" disabled={record.isPending || basis === contact.consentBasis}>
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

export function ContactDetailPage({ contactId }: { contactId: number }) {
  const { current } = useCurrentWorkspace();
  const navigate = useNavigate();
  const invalidate = useInvalidateContacts();
  const contact = useQuery(contactQuery(current.id, contactId));
  const [confirm, setConfirm] = useState<"unsubscribe" | "delete" | null>(null);

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
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/contacts/{id}", { params: { path: { id: contactId } } })),
    onSuccess: async () => {
      setConfirm(null);
      await invalidate();
      await navigate({ to: "/contacts" });
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
      <div className="flex flex-col gap-6">
        {back}
        <div className="h-48 rounded-xl border border-border bg-muted" />
      </div>
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
            <Button variant="ghost" onClick={() => setConfirm("delete")}>
              Delete
            </Button>
          </div>
        </div>
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

      <ConfirmDialog
        open={confirm === "unsubscribe"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Unsubscribe ${data.email}?`}
        description={
          errorText(unsubscribe.error) ??
          "The contact leaves every list and gets no campaign email. The contact stays visible. Only the contact can resubscribe."
        }
        confirmLabel="Unsubscribe"
        pending={unsubscribe.isPending}
        onConfirm={() => unsubscribe.mutate()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete ${data.email}?`}
        description={
          errorText(remove.error) ??
          "This removes the contact, its tags, lists, and consent history. An address that unsubscribed stays suppressed, so an import cannot add it back. To stop email only, unsubscribe instead."
        }
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
