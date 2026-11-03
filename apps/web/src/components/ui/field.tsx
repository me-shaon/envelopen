import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * A label, a control, an optional hint, and an optional error, stacked. `required` shows
 * a red asterisk after the label. Screen readers get "required" from the control, so
 * also set `required` on the control.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {required ? (
        // The asterisk is outside the label, so the accessible name stays the label text.
        <span className="flex items-baseline gap-0.5">
          <Label htmlFor={id}>{label}</Label>
          <span aria-hidden="true" className="text-[13px] font-medium text-destructive">
            *
          </span>
        </span>
      ) : (
        <Label htmlFor={id}>{label}</Label>
      )}
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="m-0 text-xs text-tone-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A form-level error message that screen readers announce. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="m-0 rounded-lg bg-tone-danger px-3 py-2 text-[13px] text-tone-danger-foreground"
    >
      {message}
    </p>
  );
}
