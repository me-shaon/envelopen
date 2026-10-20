import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Calm buttons: black primary, hairline outline, and quiet ghost. No gradients and no
// heavy shadows. Triggers of destructive actions (erase, remove, revoke, delete, archive,
// cancel a campaign) use the destructive ghost or outline variants, so they read as risky
// before the confirmation opens. The filled destructive variant is for the confirmation
// itself. The brand (clay) variant is for the confirm-send button only.
// Below the sm breakpoint every size is at least 44 px tall for touch.

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
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
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
