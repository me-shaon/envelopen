import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LogOutIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { type SessionUser, signOut } from "@/auth/auth-client";
import { initials } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function UserMenu({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const display = user.name || user.email;

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      queryClient.clear();
      await navigate({ to: "/login" });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-h-10 max-md:min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left hover:bg-sidebar-accent"
        aria-label={`Account: ${display}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-tone-lavender text-[10px] font-semibold text-tone-lavender-foreground"
            aria-hidden="true"
          >
            {initials(display)}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[13px] font-medium">{display}</span>
            {user.name ? (
              <span className="truncate text-xs text-sidebar-muted">{user.email}</span>
            ) : null}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 text-sidebar-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        <DropdownMenuLabel>Signed in as {user.email}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggle}>
          {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleSignOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
