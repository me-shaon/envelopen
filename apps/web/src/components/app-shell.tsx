import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
  BookOpenIcon,
  FileTextIcon,
  HouseIcon,
  type LucideIcon,
  MenuIcon,
  PlugIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { sessionQuery, workspacesQuery } from "@/api/queries";
import { setWorkspaceId, useWorkspaceId } from "@/api/workspace";
import type { SessionUser } from "@/auth/auth-client";
import { guideUrl } from "@/lib/guides";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { UserMenu } from "./user-menu";
import { WorkspaceContext, type WorkspaceContextValue } from "./workspace-context";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface NavItem {
  to: "/" | "/campaigns" | "/contacts" | "/templates" | "/connections" | "/settings";
  label: string;
  icon: LucideIcon;
}

const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: HouseIcon },
  { to: "/campaigns", label: "Campaigns", icon: SendIcon },
  { to: "/contacts", label: "Contacts", icon: UsersIcon },
  { to: "/templates", label: "Templates", icon: FileTextIcon },
];

const WORKSPACE_NAV: NavItem[] = [{ to: "/connections", label: "Connections", icon: PlugIcon }];

const navClass =
  "flex min-h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-sidebar-muted transition-colors hover:text-sidebar-foreground";
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
 * The frame of every signed-in page: the sidebar, the header, and the content in a
 * 1,120 px container. It resolves the current workspace before the page loads data.
 */
export function AppShell() {
  const session = useQuery(sessionQuery);
  const workspaces = useQuery(workspacesQuery);
  const storedId = useWorkspaceId();
  const [menuOpen, setMenuOpen] = useState(false);

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
      <div
        className="flex min-h-screen items-center justify-center p-6 text-muted-foreground"
        role="alert"
      >
        The workspaces did not load. Reload the page to try again.
      </div>
    );
  }
  if (!user || !current || current.id !== storedId) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <span className="sr-only">Loading</span>
      </div>
    );
  }

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
                  <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(26_25_23/0.28)] md:hidden dark:bg-black/60" />
                  <DialogPrimitive.Content
                    aria-label="Menu"
                    className="fixed inset-y-0 left-0 z-50 w-[260px] border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:hidden"
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
              <Button asChild>
                <Link to="/campaigns/new">
                  <PlusIcon className="size-[13px]" strokeWidth={2.4} aria-hidden="true" />
                  New campaign
                </Link>
              </Button>
            </div>
          </header>

          <main className="mx-auto max-w-[1120px] pt-10">
            <Outlet />
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
