import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Schemas } from "@/api/client";
import { Pill, type Tone } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

// Labels and small pieces that the contact pages share.

export type ContactStatus = Schemas["Contact"]["status"];
export type ConsentBasis = Schemas["ConsentBasis"];

export function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

const STATUS: Record<ContactStatus, { label: string; tone: Tone }> = {
  subscribed: { label: "Subscribed", tone: "teal" },
  unsubscribed: { label: "Unsubscribed", tone: "salmon" },
  suppressed: { label: "Suppressed", tone: "danger" },
};

export function StatusPill({ status }: { status: ContactStatus }) {
  const item = STATUS[status];
  return <Pill tone={item.tone}>{item.label}</Pill>;
}

export const CONSENT: Record<ConsentBasis, { label: string; detail: string }> = {
  existing_customer: {
    label: "Existing customer",
    detail: "They bought from you or used your service. For example, students of a course.",
  },
  explicit_opt_in: {
    label: "Explicit opt-in",
    detail: "They asked for your emails, for example through a signup form.",
  },
  unknown: {
    label: "Unknown",
    detail: "You do not know. These contacts get only a re-permission campaign.",
  },
};

/** A readable form of a source such as `ui`, `import:12`, or `api_key:3`. */
export function sourceLabel(source: string | null): string {
  if (!source) return "Unknown";
  if (source === "ui") return "You, in the app";
  const [kind, id] = source.split(":");
  switch (kind) {
    case "import":
      return `Import #${id}`;
    case "api_key":
      return `API key #${id}`;
    case "one_click":
      return "One-click unsubscribe";
    case "preference_page":
      return "Preference page";
    case "contact_deleted":
      return "Deleted contact";
    default:
      return source;
  }
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(ms: number | null | undefined): string {
  return ms == null ? "-" : dateTime.format(new Date(ms));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const number = new Intl.NumberFormat();

/** A count in Geist Mono. */
export function Figure({ value, className }: { value: number; className?: string }) {
  return <span className={cn("figure", className)}>{number.format(value)}</span>;
}

const TABS = [
  { to: "/contacts", label: "All contacts" },
  { to: "/contacts/lists", label: "Lists" },
  { to: "/contacts/tags", label: "Tags" },
  { to: "/contacts/suppressions", label: "Suppression list" },
] as const;

/** The audience pages: contacts, lists, tags, and the suppression list. */
export function ContactsNav() {
  return (
    <nav aria-label="Audience" className="flex flex-wrap gap-1 border-b border-hairline">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          activeOptions={{ exact: true, includeSearch: false }}
          className="-mb-px inline-flex items-end border-b-2 px-2.5 pt-1 pb-2.5 text-[13px] hover:text-foreground max-sm:min-h-11"
          // The colors go in the state props: in one class list, the later utility in the
          // stylesheet wins, so an active tab would keep the transparent border.
          activeProps={{
            className: "border-foreground font-medium text-foreground",
            "aria-current": "page",
          }}
          inactiveProps={{ className: "border-transparent text-muted-foreground" }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/** The page title with actions on the right. */
export function PageTop({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">
          {title}
        </h1>
        <p className="m-0 text-[15px] text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
