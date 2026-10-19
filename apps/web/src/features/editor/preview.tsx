import { forceDarkMode } from "@envelopen/email-render/layout";
import { MonitorIcon, MoonIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

// The email preview (R27). The HTML renders in an iframe with an empty `sandbox`
// attribute: no scripts, no same-origin access, no forms, no popups, and no top
// navigation (KTD27). So a script in a raw HTML block, or in HTML that came through the
// API, cannot run here, even before the Worker sanitizes it on save.

export type PreviewMode = "desktop" | "mobile" | "dark";

const MODES: { id: PreviewMode; label: string; icon: typeof MonitorIcon }[] = [
  { id: "desktop", label: "Desktop", icon: MonitorIcon },
  { id: "mobile", label: "Mobile", icon: SmartphoneIcon },
  { id: "dark", label: "Dark mode", icon: MoonIcon },
];

/** A row of toggle buttons in the Calm style. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: typeof MonitorIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 inline-flex gap-0.5 self-start rounded-[10px] border-0 bg-muted p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={cn(
              "inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors",
              active
                ? "bg-card font-medium text-foreground shadow-raised"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

export function EmailPreview({
  html,
  subject,
  preheader,
  missing,
}: {
  html: string | null;
  subject: string;
  preheader: string;
  missing: string[];
}) {
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const dark = mode === "dark";
  const srcDoc = html === null ? "" : dark ? forceDarkMode(html) : html;
  return (
    <div className="flex flex-col gap-4" data-testid="email-preview" data-mode={mode}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Preview size" value={mode} options={MODES} onChange={setMode} />
        {missing.length > 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            Empty for the sample contact:{" "}
            <span className="font-mono text-foreground">{missing.join(", ")}</span>. Add a fallback
            to these merge tags.
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "flex flex-col items-center rounded-xl border border-border px-3 pt-4 pb-6",
          dark ? "bg-[#141312]" : "bg-muted",
        )}
      >
        <div
          className={cn(
            "mb-3 flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-[13px]",
            dark ? "bg-[#1f1e1c] text-[#edebe6]" : "bg-card",
            mode === "mobile" ? "max-w-[375px]" : "max-w-[680px]",
          )}
        >
          <span className="truncate font-medium" data-testid="preview-subject">
            {subject || "No subject"}
          </span>
          <span className={cn("truncate", dark ? "text-[#a39e94]" : "text-muted-foreground")}>
            {preheader || "No preheader"}
          </span>
        </div>
        {html === null ? (
          <div className="h-[560px] w-full max-w-[680px] animate-pulse rounded-lg bg-card" />
        ) : (
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={srcDoc}
            referrerPolicy="no-referrer"
            className={cn(
              "h-[720px] w-full rounded-lg border-0",
              dark ? "bg-[#141312]" : "bg-white",
              mode === "mobile" ? "max-w-[375px]" : "max-w-[680px]",
            )}
          />
        )}
      </div>
    </div>
  );
}
