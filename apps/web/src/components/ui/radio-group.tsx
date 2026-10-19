import { RadioGroup as RadioPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioPrimitive.Root>) {
  return <RadioPrimitive.Root className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioPrimitive.Item>) {
  return (
    <RadioPrimitive.Item
      className={cn(
        "mt-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-card data-[state=checked]:border-foreground",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-2 rounded-full bg-foreground" />
    </RadioPrimitive.Item>
  );
}
