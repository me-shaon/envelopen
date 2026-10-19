import type { ReactNode } from "react";

/** The page title and its one-line description. */
export function PageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em]">{title}</h1>
      {description ? <p className="m-0 text-[15px] text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** A section title with optional text or an action on the right. */
export function SectionHeader({
  id,
  title,
  aside,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={id} className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      {aside ? <div className="text-[13px] text-muted-foreground">{aside}</div> : null}
    </div>
  );
}
