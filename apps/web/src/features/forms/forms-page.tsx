import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ClipboardListIcon, PlusIcon } from "lucide-react";
import type { Schemas } from "@/api/client";
import { formsQuery, listsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, PageTop } from "@/features/contacts/shared";
import { CopyValue } from "@/features/providers/shared";
import { formatDate } from "@/lib/format";

// Signup forms (U8, R10, R11). Each form has a hosted page and an iframe snippet for a
// website. Every signup is double opt-in: the subscriber confirms from an email first.

export type SignupForm = Schemas["SignupForm"];

/** The notice when the deployment has no Turnstile keys. Forms refuse signups then. */
export function TurnstileNotice() {
  return (
    <div
      role="alert"
      data-testid="turnstile-notice"
      className="rounded-xl bg-tone-salmon px-4 py-3 text-[13px] text-tone-salmon-foreground"
    >
      <p className="m-0 font-medium">Forms cannot take signups yet</p>
      <p className="m-0 mt-1">
        Add a Cloudflare Turnstile widget for this hostname in the Cloudflare dashboard. Then set
        the secrets TURNSTILE_SITE_KEY and TURNSTILE_SECRET on the Worker. Until then, forms show
        "This form is not available" and refuse every submission.
      </p>
    </div>
  );
}

export function FormsPage() {
  const { current } = useCurrentWorkspace();
  const navigate = useNavigate();
  const forms = useQuery(formsQuery(current.id));
  const lists = useQuery(listsQuery(current.id));
  const listName = (id: number) => lists.data?.items.find((list) => list.id === id)?.name;
  const items = forms.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop
        title="Forms"
        description="Signup forms for your website, with a confirmation email before each subscription."
        actions={
          <Button
            onClick={() => void navigate({ to: "/forms/$formId", params: { formId: "new" } })}
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New form
          </Button>
        }
      />
      {forms.data && !forms.data.turnstileConfigured ? <TurnstileNotice /> : null}
      {forms.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          {errorText(forms.error)}
        </p>
      ) : forms.isPending ? (
        <TableSkeleton label="Loading the forms" rows={3} columns={4} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClipboardListIcon}
          title="No forms yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/forms/$formId" params={{ formId: "new" }}>
                Create your first form
              </Link>
            </Button>
          }
        >
          A form adds subscribers to your lists. Share its page, or put it on your website with an
          iframe. Each subscriber confirms the address from an email first.
        </EmptyState>
      ) : (
        <Table aria-label="Forms">
          <thead>
            <tr>
              <TableHead>Form</TableHead>
              <TableHead>Lists</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Hosted page</TableHead>
              <TableHead>Updated</TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map((form) => (
              <TableRow key={form.id} data-testid="form-row">
                <TableCell className="font-medium">
                  <Link
                    to="/forms/$formId"
                    params={{ formId: String(form.id) }}
                    className="hover:underline"
                  >
                    {form.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[220px] truncate text-muted-foreground">
                  {form.listIds.map((id) => listName(id) ?? `List ${id}`).join(", ") || "No list"}
                </TableCell>
                <TableCell>
                  <Pill tone={form.enabled ? "teal" : "neutral"}>
                    {form.enabled ? "On" : "Off"}
                  </Pill>
                </TableCell>
                <TableCell className="min-w-[220px] max-w-[320px]">
                  {form.hostedUrl ? <CopyValue label="hosted link" value={form.hostedUrl} /> : null}
                </TableCell>
                <TableCell className="figure text-muted-foreground">
                  {formatDate(form.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
