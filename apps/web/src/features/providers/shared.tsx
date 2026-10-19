import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Schemas } from "@/api/client";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

// Pieces that the provider and domain pages share.

export type Provider = Schemas["Provider"];
export type Connection = Schemas["Connection"];
export type ConnectionDetail = Schemas["ConnectionDetail"];
export type SendingDomain = Schemas["SendingDomain"];
export type CheckStatus = SendingDomain["spf"]["status"];

export const CONNECTION_STATUS: Record<Connection["status"], { label: string; tone: Tone }> = {
  active: { label: "Connected", tone: "teal" },
  error: { label: "Needs attention", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
};

export const EVENTS_SETUP: Record<Connection["eventsSetup"], string> = {
  auto: "Envelopen created the webhook. Bounces and complaints arrive on their own.",
  manual: "Set up the webhook by hand to receive bounces and complaints.",
  none: "This provider sends no events to Envelopen.",
};

export const CHECK_STATUS: Record<CheckStatus, { label: string; tone: Tone }> = {
  pass: { label: "Verified", tone: "teal" },
  missing: { label: "Waiting", tone: "lavender" },
  fail: { label: "Wrong", tone: "danger" },
  error: { label: "Not checked", tone: "salmon" },
  unknown: { label: "Not set", tone: "neutral" },
};

export const DOMAIN_STATUS: Record<SendingDomain["status"], { label: string; tone: Tone }> = {
  verified: { label: "Verified", tone: "teal" },
  pending: { label: "Waiting for DNS", tone: "lavender" },
  failed: { label: "Fix DNS", tone: "danger" },
};

const TABS = [
  { to: "/connections", label: "Providers" },
  { to: "/connections/domains", label: "Sending domains" },
] as const;

/** The two connection pages: providers and sending domains. */
export function ConnectionsNav() {
  return (
    <nav aria-label="Connections" className="flex flex-wrap gap-1 border-b border-hairline">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          activeOptions={{ exact: tab.to === "/connections", includeSearch: false }}
          className="-mb-px border-b-2 px-2.5 pt-1 pb-2.5 text-[13px] hover:text-foreground"
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

/** A read-only value in Geist Mono with a copy button. */
export function CopyValue({
  label,
  value,
  testId,
  className,
}: {
  label: string;
  value: string;
  testId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-[9px] border border-input bg-card py-1 pr-1 pl-3",
        className,
      )}
    >
      <code
        className="min-w-0 flex-1 truncate font-mono text-[12px]"
        title={value}
        data-testid={testId}
      >
        {value}
      </code>
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copy()}>
        {copied ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
        <span className="sr-only">{copied ? `${label} copied` : `Copy ${label}`}</span>
      </Button>
    </div>
  );
}

/** A quiet note box. Salmon for warnings, lavender for information. */
export function Note({
  tone = "lavender",
  title,
  children,
  testId,
}: {
  tone?: "lavender" | "salmon" | "danger";
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  const tones = {
    lavender: "bg-tone-lavender text-tone-lavender-foreground",
    salmon: "bg-tone-salmon text-tone-salmon-foreground",
    danger: "bg-tone-danger text-tone-danger-foreground",
  };
  return (
    <div
      className={cn("flex flex-col gap-1 rounded-lg px-3 py-2.5 text-[13px]", tones[tone])}
      data-testid={testId}
    >
      {title ? <p className="m-0 font-medium">{title}</p> : null}
      <div className="leading-normal">{children}</div>
    </div>
  );
}
