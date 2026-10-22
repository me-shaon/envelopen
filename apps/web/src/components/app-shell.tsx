import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookOpenIcon,
  CircleAlertIcon,
  ClipboardListIcon,
  FileTextIcon,
  HouseIcon,
  type LucideIcon,
  MailPlusIcon,
  MenuIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import {
  backupStatusQuery,
  deploymentSettingsQuery,
  sessionQuery,
  workspacesQuery,
} from "@/api/queries";
import { setWorkspaceId, useWorkspaceId } from "@/api/workspace";
import type { SessionUser } from "@/auth/auth-client";
import { UsageCard } from "@/features/usage/usage-card";
import { formatDateTime } from "@/lib/format";
import { guideUrl } from "@/lib/guides";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { LoadingRegion, Skeleton } from "./ui/skeleton";
import { UserMenu } from "./user-menu";
import { WorkspaceContext, type WorkspaceContextValue } from "./workspace-context";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface NavItem {
  to:
    | "/"
    | "/campaigns"
    | "/contacts"
    | "/templates"
    | "/forms"
    | "/welcome"
    | "/brand"
    | "/connections"
    | "/settings";
  label: string;
  icon: LucideIcon;
}

const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: HouseIcon },
  { to: "/campaigns", label: "Campaigns", icon: SendIcon },
  { to: "/contacts", label: "Contacts", icon: UsersIcon },
  { to: "/templates", label: "Templates", icon: FileTextIcon },
  { to: "/forms", label: "Forms", icon: ClipboardListIcon },
  { to: "/welcome", label: "Welcome series", icon: MailPlusIcon },
];

const WORKSPACE_NAV: NavItem[] = [
  { to: "/brand", label: "Brand", icon: PaletteIcon },
  { to: "/connections", label: "Connections", icon: PlugIcon },
];

const navClass =
  "flex min-h-8 max-md:min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-sidebar-muted transition-[color,background-color,box-shadow] duration-(--duration-press) ease-out hover:text-sidebar-foreground [&:not([aria-current=page])]:hover:bg-sidebar-accent/60";
const activeClass = "bg-sidebar-accent font-medium text-sidebar-foreground shadow-raised";

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={navClass}
      activeProps={{ className: activeClass, "aria-current": "page" }}
      activeOptions={{ exact: item.to === "/" }}
      onClick={onNavigate}
    >
      <Icon className="size-4" strokeWidth={1.7} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function SidebarContent({
  workspace,
  user,
  onNavigate,
}: {
  workspace: WorkspaceContextValue;
  user: SessionUser;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <div className="px-2">
        <Logo />
      </div>
      <WorkspaceSwitcher workspaces={workspace.workspaces} current={workspace.current} />
      <div className="flex flex-col gap-px">
        {MAIN_NAV.map((item) => (
          <NavLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
      <div className="flex flex-col gap-px">
        <span className="px-2.5 pb-1.5 text-xs text-sidebar-muted">Workspace</span>
        {WORKSPACE_NAV.map((item) => (
          <NavLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <UsageCard onNavigate={onNavigate} />
        <div className="flex flex-col gap-px">
          <a
            href={guideUrl("docs/guides/README.md")}
            className={navClass}
            target="_blank"
            rel="noreferrer"
          >
            <BookOpenIcon className="size-4" strokeWidth={1.7} aria-hidden="true" />
            Guides
          </a>
          <NavLink
            item={{ to: "/settings", label: "Settings", icon: SettingsIcon }}
            onNavigate={onNavigate}
          />
        </div>
        <div className="border-t border-sidebar-border pt-3">
          <UserMenu user={user} />
        </div>
      </div>
    </div>
  );
}

/**
 * The footer of every signed-in page: the version and the link to the source code of
 * this deployment (AGPL section 13, KTD16). The owner sets the link in Settings.
 */
function AppFooter() {
  const settings = useQuery(deploymentSettingsQuery);
  const sourceUrl = settings.data?.sourceUrl;
  return (
    <footer className="mx-auto mt-16 flex max-w-[1120px] flex-wrap items-center gap-x-2 gap-y-1 border-t border-hairline pt-5 text-xs text-muted-foreground">
      <span>Envelopen {__ENVELOPEN_VERSION__}</span>
      {sourceUrl ? (
        <>
          <span aria-hidden="true">·</span>
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="source-link"
            // Underlined, so the link stands out from the footer text without color.
            className="rounded-sm underline decoration-border underline-offset-[3px] transition-colors duration-(--duration-press) hover:text-foreground"
          >
            Source code
          </a>
        </>
      ) : null}
    </footer>
  );
}

/**
 * The backup warning on every signed-in page (R4, AE7). It shows while the last backup
 * failed, or reached R2 without its S3 copy, with the time of the last successful
 * backup. It goes away when a backup succeeds. After a restore, it says that campaign
 * sends wait for the owner (KTD3).
 */
function BackupBanner() {
  const status = useQuery(backupStatusQuery);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const data = status.data;
  if (!data) return null;
  const last = data.lastRun;
  let message: string | null = null;
  let tone = "bg-tone-danger text-tone-danger-foreground";
  if (data.restore) {
    tone = "bg-tone-salmon text-tone-salmon-foreground";
    message = `This deployment was restored from a backup of ${formatDateTime(data.restore.backupCreatedAt)}. Campaign sends wait until you confirm the age of the backup.`;
  } else if (last?.status === "failed" || last?.status === "partial") {
    const success = data.lastSuccess
      ? `The last successful backup was on ${formatDateTime(data.lastSuccess.startedAt)}.`
      : "No backup has succeeded yet.";
    message =
      last.status === "failed"
        ? `The backup of ${formatDateTime(last.startedAt)} failed. ${success}`
        : `The backup of ${formatDateTime(last.startedAt)} reached R2, but its S3 copy failed. ${success}`;
  }
  if (!message) return null;
  return (
    <div
      role="alert"
      data-testid="backup-banner"
      className={`mx-auto mt-4 flex max-w-[1120px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 text-[13px] ${tone}`}
    >
      <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {pathname === "/settings" ? null : (
        <Link
          to="/settings"
          hash="backups"
          className="font-medium underline underline-offset-[3px]"
        >
          Open the backup settings
        </Link>
      )}
    </div>
  );
}

/**
 * The first load: the frame of the shell with placeholder blocks where the workspace,
 * the navigation, and the page will be. The sidebar and the header keep their sizes, so
 * nothing moves when the real shell replaces it.
 */
function ShellSkeleton() {
  return (
    <LoadingRegion label="Loading Envelopen" className="flex min-h-screen bg-background">
      <div className="hidden w-[232px] shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <div className="flex h-screen flex-col gap-6 px-3 py-5">
          <div className="px-2">
            <Logo />
          </div>
          <Skeleton className="h-10 rounded-[10px]" />
          <div className="flex flex-col gap-3 px-2.5 pt-1">
            {["w-20", "w-24", "w-[70px]", "w-[76px]"].map((width) => (
              <div key={width} className="flex h-5 items-center gap-2.5">
                <Skeleton className="size-4 rounded-[5px]" />
                <Skeleton className={`h-3 rounded-sm ${width}`} />
              </div>
            ))}
          </div>
          <div className="mt-auto flex flex-col gap-3">
            <Skeleton className="h-[92px] rounded-[10px]" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1 px-4 pb-16 sm:px-10">
        <div className="mx-auto flex h-[73px] max-w-[1120px] items-center justify-end gap-2 border-b border-hairline">
          <Skeleton className="size-9 rounded-[9px]" />
          <Skeleton className="h-9 w-[132px] rounded-[9px]" />
        </div>
        <div className="mx-auto flex max-w-[1120px] flex-col gap-12 pt-10">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-[34px] w-[260px]" />
            <Skeleton className="h-4 w-[340px] max-w-full rounded-sm" />
          </div>
          <Skeleton className="h-[132px] rounded-xl" />
          <Skeleton className="h-[220px] rounded-xl" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * The frame of every signed-in page: the sidebar, the header, and the content in a
 * 1,120 px container. It resolves the current workspace before the page loads data.
 */
export function AppShell() {
  const session = useQuery(sessionQuery);
  const workspaces = useQuery(workspacesQuery);
  const storedId = useWorkspaceId();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The campaigns pages have their own "New campaign" action, so the header leaves it out.
  const showNewCampaign = pathname !== "/campaigns" && pathname !== "/campaigns/new";

  const items = workspaces.data?.items ?? [];
  const active = items.filter((workspace) => workspace.archivedAt === null);
  const current = active.find((workspace) => workspace.id === storedId) ?? active[0];

  // Keep the stored id in step with the list: a new browser, or an archived workspace.
  useEffect(() => {
    if (current && current.id !== storedId) setWorkspaceId(current.id);
  }, [current, storedId]);

  const user = session.data?.user;
  if (workspaces.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          The workspaces did not load. Check the connection, then try again.
        </p>
        <Button
          variant="outline"
          pending={workspaces.isFetching}
          onClick={() => void workspaces.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!user || !current || current.id !== storedId) return <ShellSkeleton />;

  const workspace: WorkspaceContextValue = { current, workspaces: items };

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="flex min-h-screen bg-background text-foreground">
        <nav
          aria-label="Main"
          className="hidden w-[232px] shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:block"
        >
          <div className="sticky top-0 h-screen">
            <SidebarContent workspace={workspace} user={user} />
          </div>
        </nav>

        <div className="min-w-0 flex-1 px-4 pb-16 sm:px-10">
          <header className="mx-auto flex max-w-[1120px] items-center justify-between gap-4 border-b border-hairline py-[18px]">
            <div className="flex items-center gap-2">
              <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <DialogPrimitive.Trigger asChild>
                  <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                    <MenuIcon className="size-4" aria-hidden="true" />
                  </Button>
                </DialogPrimitive.Trigger>
                <DialogPrimitive.Portal>
                  <DialogPrimitive.Overlay className="motion-overlay fixed inset-0 z-40 bg-[rgb(26_25_23/0.28)] md:hidden dark:bg-black/60" />
                  <DialogPrimitive.Content
                    aria-label="Menu"
                    className="motion-sheet fixed inset-y-0 left-0 z-50 w-[260px] border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:hidden"
                  >
                    <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
                    <DialogPrimitive.Description className="sr-only">
                      Navigation and workspace
                    </DialogPrimitive.Description>
                    <SidebarContent
                      workspace={workspace}
                      user={user}
                      onNavigate={() => setMenuOpen(false)}
                    />
                  </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
              <span className="text-[13px] text-muted-foreground md:hidden">{current.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              {showNewCampaign ? (
                <Button asChild>
                  <Link to="/campaigns/new">
                    <PlusIcon className="size-[13px]" strokeWidth={2.4} aria-hidden="true" />
                    New campaign
                  </Link>
                </Button>
              ) : null}
            </div>
          </header>

          <BackupBanner />
          <main className="mx-auto max-w-[1120px] pt-10">
            <Outlet />
          </main>
          <AppFooter />
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
