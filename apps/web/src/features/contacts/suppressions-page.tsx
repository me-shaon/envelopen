import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SearchIcon, ShieldOffIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { suppressionsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { ContactsNav, errorText, Figure, formatDateTime, PageTop, sourceLabel } from "./shared";

// The suppression list (R19). Rows hold a keyed hash, not the address, so an address
// shows only when a contact has it. The search checks one address by its hash.

type Suppression = Schemas["Suppression"];

const REASONS: Record<Suppression["reason"], { label: string; tone: Tone }> = {
  hard_bounce: { label: "Hard bounce", tone: "danger" },
  complaint: { label: "Complaint", tone: "danger" },
  soft_bounce_limit: { label: "Soft bounces", tone: "salmon" },
  manual: { label: "Manual", tone: "neutral" },
  erased: { label: "Deleted contact", tone: "lavender" },
};

function AddForm() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: (emails: string[]) => unwrap(api.POST("/suppressions", { body: { emails } })),
    onSuccess: async () => {
      setText("");
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
    },
  });
  const emails = text
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (emails.length > 0) add.mutate(emails.slice(0, 100));
  }

  const result = add.data;
  return (
    <form className="flex max-w-[560px] flex-col gap-3" onSubmit={onSubmit}>
      <FormError message={errorText(add.error)} />
      <Field
        id="suppress-emails"
        label="Block addresses"
        hint="One address per line, up to 100. Envelopen never sends to them, and imports skip them."
      >
        <Textarea
          id="suppress-emails"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby="suppress-emails-hint"
          className="min-h-20 font-mono text-[12.5px]"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={add.isPending || emails.length === 0}>
          <span>
            Suppress <Figure value={emails.length} />{" "}
            {emails.length === 1 ? "address" : "addresses"}
          </span>
        </Button>
        {result ? (
          <span role="status" className="text-xs text-muted-foreground">
            <Figure value={result.added} /> added, <Figure value={result.alreadySuppressed} />{" "}
            already suppressed
            {result.invalid.length > 0 ? `, not valid: ${result.invalid.join(", ")}` : ""}.
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function SuppressionsPage() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [lookup, setLookup] = useState("");
  const [email, setEmail] = useState("");
  const suppressions = useInfiniteQuery(suppressionsQuery(current.id, email));
  const [removing, setRemoving] = useState<Suppression | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE("/suppressions/{id}", { params: { path: { id } } })),
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
    },
  });
  const items = suppressions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop title="Contacts" description="Your audience, with lists, tags, and consent." />
      <div className="flex flex-col gap-6">
        <ContactsNav />
        <AddForm />
        <section aria-labelledby="suppressed-title" className="flex flex-col gap-4">
          <SectionHeader
            id="suppressed-title"
            title="Suppressed addresses"
            aside="Hard bounces, complaints, and manual blocks"
          />
          <form
            aria-label="Check an address"
            className="flex max-w-[480px] gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setEmail(lookup.trim());
            }}
          >
            <Input
              type="search"
              aria-label="Check an address"
              placeholder="Check an address"
              value={lookup}
              onChange={(event) => {
                setLookup(event.target.value);
                if (event.target.value === "") setEmail("");
              }}
            />
            <Button type="submit" variant="outline">
              <SearchIcon className="size-3.5" aria-hidden="true" />
              Check
            </Button>
          </form>
          {suppressions.isError ? (
            <p role="alert" className="m-0 text-[13px] text-muted-foreground">
              {errorText(suppressions.error)}
            </p>
          ) : suppressions.isPending ? (
            <div className="h-32 rounded-xl border border-border bg-muted" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={ShieldOffIcon}
              title={email ? `${email} is not suppressed` : "Nothing is suppressed"}
            >
              Bounces and complaints from your provider land here on their own.
            </EmptyState>
          ) : (
            <Table aria-label="Suppressed addresses">
              <thead>
                <tr>
                  <TableHead>Address</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <TableRow key={item.id} data-testid="suppression-row">
                    <TableCell>
                      {item.contactId && item.email ? (
                        <Link
                          to="/contacts/$contactId"
                          params={{ contactId: String(item.contactId) }}
                          className="font-medium hover:underline"
                        >
                          {item.email}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">
                          {email || "Address not stored"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Pill tone={REASONS[item.reason].tone}>{REASONS[item.reason].label}</Pill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sourceLabel(item.source)}
                    </TableCell>
                    <TableCell className="figure whitespace-nowrap text-muted-foreground">
                      {formatDateTime(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="destructive-ghost"
                        size="sm"
                        onClick={() => setRemoving(item)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          )}
          {suppressions.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                onClick={() => void suppressions.fetchNextPage()}
                disabled={suppressions.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </section>
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this suppression?"
        description={
          errorText(remove.error) ??
          "Email can reach the address again. Remove a bounce or a complaint only when you know the address works and wants your email."
        }
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}
