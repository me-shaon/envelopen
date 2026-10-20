import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { workspacesQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { WorkspaceMark } from "@/components/workspace-switcher";
import { formatDate } from "@/lib/format";

type Workspace = Schemas["WorkspaceSummary"];

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function RenameDialog({
  workspace,
  onOpenChange,
}: {
  workspace: Workspace | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (input: { id: number; name: string }) =>
      unwrap(
        api.PATCH("/workspaces/{id}", {
          params: { path: { id: input.id } },
          body: { name: input.name },
        }),
      ),
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      onOpenChange(false);
      toast(`Workspace renamed to ${input.name}.`);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    rename.mutate({ id: workspace.id, name });
  }

  return (
    <Dialog
      open={workspace !== null}
      onOpenChange={(open) => {
        if (!open) rename.reset();
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader title="Rename workspace" />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(rename.error)} />
          <Field id="rename-workspace" label="Name">
            <Input
              id="rename-workspace"
              name="name"
              required
              maxLength={100}
              defaultValue={workspace?.name}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" pending={rename.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspacesSection() {
  const queryClient = useQueryClient();
  const { current, workspaces } = useCurrentWorkspace();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [archiving, setArchiving] = useState<Workspace | null>(null);

  const create = useMutation({
    mutationFn: (value: string) => unwrap(api.POST("/workspaces", { body: { name: value } })),
    onSuccess: async (_data, value) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      toast(`Workspace ${value} created. Switch to it from the sidebar.`);
    },
  });

  const archive = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST("/workspaces/{id}/archive", { params: { path: { id } } })),
    onSuccess: async () => {
      setArchiving(null);
      // The shell moves to another workspace when the current one is archived.
      await queryClient.invalidateQueries();
    },
  });

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(name.trim());
  }

  return (
    <section id="workspaces" aria-labelledby="workspaces-title" className="flex flex-col gap-4">
      <SectionHeader
        id="workspaces-title"
        title="Workspaces"
        aside="Each workspace has its own contacts, campaigns, and keys."
      />

      <ul className="m-0 flex list-none flex-col rounded-xl border border-border p-0">
        {workspaces.map((workspace) => {
          const archived = workspace.archivedAt !== null;
          return (
            <li
              key={workspace.id}
              data-testid="workspace-row"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <WorkspaceMark name={workspace.name} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{workspace.name}</span>
                  <span className="text-xs text-muted-foreground">
                    Created {formatDate(workspace.createdAt)}
                  </span>
                </div>
                {workspace.id === current.id ? <Pill tone="lavender">Current</Pill> : null}
                {archived ? <Pill>Archived</Pill> : null}
              </div>
              {archived ? null : (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setRenaming(workspace)}>
                    Rename<span className="sr-only"> {workspace.name}</span>
                  </Button>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    onClick={() => {
                      archive.reset();
                      setArchiving(workspace);
                    }}
                  >
                    Archive<span className="sr-only"> {workspace.name}</span>
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form className="flex max-w-[640px] flex-wrap items-end gap-3" onSubmit={onCreate}>
        <Field id="new-workspace" label="New workspace" className="min-w-[220px] flex-1">
          <Input
            id="new-workspace"
            name="name"
            required
            maxLength={100}
            placeholder="For example, Course Academy"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          pending={create.isPending}
          disabled={name.trim().length === 0}
        >
          Create workspace
        </Button>
      </form>
      <FormError message={errorText(create.error)} />

      <RenameDialog workspace={renaming} onOpenChange={(open) => !open && setRenaming(null)} />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "workspace"}?`}
        description={
          archive.error
            ? errorText(archive.error)
            : "Its API keys stop working, and it leaves the workspace switcher. The data stays."
        }
        confirmLabel="Archive"
        pending={archive.isPending}
        onConfirm={() => archiving && archive.mutate(archiving.id)}
      />
    </section>
  );
}
