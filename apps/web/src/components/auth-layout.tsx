import type { ReactNode } from "react";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/** The frame of the signed-out pages: login, first-run setup, and recovery. */
export function AuthLayout({
  title,
  description,
  wide = false,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-sidebar text-foreground">
      <header className="flex items-center justify-between px-6 py-5">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16">
        <div className={wide ? "w-full max-w-[640px]" : "w-full max-w-[400px]"}>
          <div className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-6 sm:p-8">
            <div className="flex flex-col gap-2">
              <h1 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em] text-balance">
                {title}
              </h1>
              {description ? (
                <p className="m-0 text-[15px] text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {children}
          </div>
          {footer ? (
            <div className="mt-6 flex flex-col items-center gap-2.5 text-center text-[13px] text-muted-foreground">
              {footer}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
