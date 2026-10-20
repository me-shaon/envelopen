import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, SendIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { domainsQuery, testAddressesQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";

// Test sends (R30, R72). A test goes only to the owner's address and to the addresses
// added here. The email carries both unsubscribe headers, so "Show original" in Gmail
// shows them before the first campaign.

type TestResult = Schemas["TestSendResult"];

export function TestSendSection({ hasConnection }: { hasConnection: boolean }) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const addresses = useQuery(testAddressesQuery(current.id));
  const domains = useQuery(domainsQuery(current.id));
  const firstDomain = domains.data?.items[0]?.domain;
  const [newAddress, setNewAddress] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [from, setFrom] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });

  const add = useMutation({
    mutationFn: (email: string) => unwrap(api.POST("/test-addresses", { body: { email } })),
    onSuccess: async () => {
      setNewAddress("");
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE("/test-addresses/{id}", { params: { path: { id } } })),
    onSuccess: invalidate,
  });
  const send = useMutation({
    mutationFn: (input: { to: string[]; from: string }) =>
      unwrap(api.POST("/test-sends", { body: input })),
    onSuccess: invalidate,
  });

  const items = addresses.data?.items ?? [];
  const owner = items.find((item) => item.owner)?.email;
  const recipients = picked ?? (owner ? [owner] : []);
  const fromValue = from || (firstDomain ? `hello@${firstDomain}` : "");

  function onSend(event: FormEvent) {
    event.preventDefault();
    if (recipients.length > 0 && fromValue)
      send.mutate({ to: recipients.slice(0, 5), from: fromValue });
  }

  const result: TestResult | undefined = send.data;
  return (
    <section
      id="test-send"
      aria-labelledby="test-send-title"
      className="flex scroll-mt-6 flex-col gap-4"
    >
      <SectionHeader
        id="test-send-title"
        title="Send a test"
        aside="Only to you and the addresses you add"
      />
      <div className="grid gap-4 rounded-xl border border-border p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <span className="text-[13px] font-medium">Test addresses</span>
          <FormError message={errorText(add.error) ?? errorText(remove.error)} />
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Test addresses">
            {items.map((item) => {
              const id = `test-to-${item.email}`;
              return (
                <li
                  key={item.email}
                  className="flex items-center gap-2.5"
                  data-testid="test-address"
                >
                  <Checkbox
                    id={id}
                    checked={recipients.includes(item.email)}
                    onCheckedChange={(checked) =>
                      setPicked(
                        checked === true
                          ? [...recipients, item.email]
                          : recipients.filter((email) => email !== item.email),
                      )
                    }
                  />
                  <Label
                    htmlFor={id}
                    className="min-w-0 flex-1 cursor-pointer truncate font-normal"
                  >
                    {item.email}
                  </Label>
                  {item.owner ? (
                    <Pill>You</Pill>
                  ) : item.id !== null ? (
                    <Button
                      variant="destructive-ghost"
                      size="icon-sm"
                      onClick={() => item.id !== null && remove.mutate(item.id)}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">Remove {item.email}</span>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (newAddress.trim()) add.mutate(newAddress.trim());
            }}
          >
            <Field id="new-test-address" label="Add an address" className="flex-1">
              <Input
                id="new-test-address"
                type="email"
                value={newAddress}
                placeholder="colleague@example.com"
                onChange={(event) => setNewAddress(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="outline" disabled={add.isPending || !newAddress.trim()}>
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add
            </Button>
          </form>
        </div>

        <form className="flex flex-col gap-3" onSubmit={onSend}>
          <FormError message={errorText(send.error)} />
          <Field
            id="test-from"
            label="From address"
            hint={
              firstDomain
                ? "Must be on one of your sending domains."
                : "Add a sending domain first."
            }
          >
            <Input
              id="test-from"
              type="email"
              value={fromValue}
              onChange={(event) => setFrom(event.target.value)}
              aria-describedby="test-from-hint"
            />
          </Field>
          <div className="mt-auto flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={!hasConnection || send.isPending || recipients.length === 0 || !fromValue}
            >
              <SendIcon className="size-3.5" aria-hidden="true" />
              {send.isPending
                ? "Sending..."
                : `Send to ${recipients.length} ${recipients.length === 1 ? "address" : "addresses"}`}
            </Button>
            {!hasConnection ? (
              <span className="text-xs text-muted-foreground">Connect a provider first.</span>
            ) : null}
          </div>
          {result ? (
            <div role="status">
              <ul
                className="m-0 flex list-none flex-col gap-1 p-0 text-xs"
                data-testid="test-results"
              >
                {result.results.map((item) => (
                  <li key={item.to} className="flex items-center gap-2">
                    <Pill tone={item.outcome === "sent" ? "teal" : "danger"}>
                      {item.outcome === "sent" ? "Sent" : "Not sent"}
                    </Pill>
                    <span className="truncate">{item.to}</span>
                    {item.message ? (
                      <span className="text-muted-foreground">{item.message}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
