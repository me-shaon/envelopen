import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { Children, type ComponentProps, isValidElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

// Calm buttons: black primary, hairline outline, and quiet ghost. No gradients and no
// heavy shadows. Triggers of destructive actions (erase, remove, revoke, delete, archive,
// cancel a campaign) use the destructive ghost or outline variants, so they read as risky
// before the confirmation opens. The filled destructive variant is for the confirmation
// itself. The brand (clay) variant is for the confirm-send button only.
// Below the sm breakpoint every size is at least 44 px tall for touch.
// Hover and press answer in 120 ms: the fill changes, and a press sinks the button by
// a fraction. `pending` shows a spinner while a mutation runs. The label stays and the
// width does not change.

export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-[color,background-color,border-color,opacity,scale] duration-(--duration-press) ease-out active:scale-[0.98] disabled:pointer-events-none [&:disabled:not([data-pending])]:opacity-50 data-[pending]:opacity-80 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-input bg-card text-foreground hover:bg-accent",
        ghost: "text-foreground hover:bg-accent",
        soft: "bg-tone-teal text-tone-teal-foreground hover:opacity-90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        "destructive-ghost":
          "text-destructive hover:bg-tone-danger hover:text-tone-danger-foreground",
        "destructive-outline":
          "border border-input bg-card text-destructive hover:border-transparent hover:bg-tone-danger hover:text-tone-danger-foreground",
        brand: "bg-brand-strong text-brand-strong-foreground hover:bg-brand-strong/90",
      },
      size: {
        default: "min-h-9 px-3.5 text-[13px] max-sm:min-h-11",
        sm: "min-h-[30px] rounded-md px-2.5 text-[12.5px] max-sm:min-h-11",
        icon: "size-9 max-sm:size-11",
        "icon-sm": "size-8 rounded-md max-sm:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Renders the child element, for example a link, with the button styles. */
  asChild?: boolean;
  /** A mutation runs: the button is disabled and shows a spinner. */
  pending?: boolean;
}

/**
 * The pending content. A leading icon gives its place to the spinner, so the label
 * stays visible. A button without an icon keeps its label for screen readers and its
 * width, and shows the spinner in the middle.
 */
function pendingContent(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  const [first, ...rest] = items;
  if (isValidElement(first) && typeof first.type !== "string") {
    return (
      <>
        <Spinner />
        {rest}
      </>
    );
  }
  return (
    <>
      <span className="inline-flex items-center gap-1.5 opacity-0">{children}</span>
      <span className="absolute inset-0 flex items-center justify-center">
        <Spinner />
      </span>
    </>
  );
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      data-slot="button"
      data-pending={pending ? "" : undefined}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={classes}
      {...props}
    >
      {pending ? pendingContent(children) : children}
    </button>
  );
}
