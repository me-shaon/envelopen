import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import type { Schemas } from "@/api/client";
import { setWorkspaceId } from "@/api/workspace";
import { initials } from "@/lib/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function WorkspaceMark({ name }: { name: string }) {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-tone-teal text-[10px] font-semibold text-tone-teal-foreground"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Picks the workspace for every API call. A change sets the X-Envelopen-Workspace
 * header and refetches all data.
 */
export function WorkspaceSwitcher({
  workspaces,
  current,
}: {
  workspaces: Schemas["WorkspaceSummary"][];
  current: Schemas["WorkspaceSummary"];
}) {
  const queryClient = useQueryClient();
  const active = workspaces.filter((workspace) => workspace.archivedAt === null);

  function select(value: string) {
    const id = Number(value);
    if (id === current.id) return;
    setWorkspaceId(id);
    void queryClient.invalidateQueries();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-h-10 max-md:min-h-11 w-full items-center justify-between gap-2 rounded-[10px] border border-input bg-card px-2.5 text-left"
        aria-label={`Workspace: ${current.name}. Switch workspace`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <WorkspaceMark name={current.name} />
          <span className="truncate font-medium" data-testid="current-workspace">
            {current.name}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(current.id)} onValueChange={select}>
          {active.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.id} value={String(workspace.id)}>
              <WorkspaceMark name={workspace.name} />
              <span className="truncate">{workspace.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" hash="workspaces">
            <PlusIcon aria-hidden="true" />
            Manage workspaces
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
