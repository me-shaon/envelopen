import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SendIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { domainsQuery, testAddressesQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";

// A test send from the editor (R30). It goes through the existing test-send operation
// with the template id, so the Worker personalizes the saved template with the same
// sample values as the preview. Recipients are limited to the test list (R72).

export function SendTestDialog({
  open,
  onOpenChange,
  prepare,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Saves the template first and returns its id. */
  prepare: () => Promise<number>;
}) {
  const { current } = useCurrentWorkspace();
  const addresses = useQuery({ ...testAddressesQuery(current.id), enabled: open });
  const domains = useQuery({ ...domainsQuery(current.id), enabled: open });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [from, setFrom] = useState("");
  const items = addresses.data?.items ?? [];
  const owner = items.find((item) => item.owner)?.email;
  const recipients = picked ?? (owner ? [owner] : []);
  const firstDomain = domains.data?.items[0]?.domain;
  const fromValue = from || (firstDomain ? `hello@${firstDomain}` : "");

  const send = useMutation({
    mutationFn: async () => {
      const templateId = await prepare();
      return unwrap(
        api.POST("/test-sends", {
          body: { to: recipients.slice(0, 5), from: fromValue, templateId },
        }),
      );
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (recipients.length > 0 && fromValue) send.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) send.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          title="Send a test"
          description="Envelopen saves the template, then sends it with the sample values of the preview."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(send.error)} />
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-[13px] font-medium">Send to</legend>
            {items.map((item) => {
              const id = `editor-test-${item.email}`;
              return (
                <div key={item.email} className="flex items-center gap-2.5">
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
                  {item.owner ? <Pill>You</Pill> : null}
                </div>
              );
            })}
            <p className="m-0 text-xs text-muted-foreground">
              Add test addresses on the{" "}
              <Link to="/connections" hash="test-send" className="underline">
                connections page
              </Link>
              .
            </p>
          </fieldset>
          <Field
            id="editor-test-from"
            label="From address"
            hint={
              firstDomain
                ? "Must be on one of your sending domains."
                : "Add a sending domain first."
            }
          >
            <Input
              id="editor-test-from"
              type="email"
              value={fromValue}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          {send.data ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" role="status">
              {send.data.results.map((item) => (
                <li key={item.to} className="flex items-center gap-2">
                  <Pill tone={item.outcome === "sent" ? "teal" : "danger"}>
                    {item.outcome === "sent" ? "Sent" : "Not sent"}
                  </Pill>
                  <span className="truncate">{item.to}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="submit"
              disabled={send.isPending || recipients.length === 0 || !fromValue}
            >
              <SendIcon className="size-3.5" aria-hidden="true" />
              {send.isPending ? "Sending..." : "Send test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
