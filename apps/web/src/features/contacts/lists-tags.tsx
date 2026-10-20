import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListIcon, PlusIcon, TagIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { listsQuery, tagsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { formatDate } from "@/lib/format";
import { ContactsNav, errorText, Figure, PageTop } from "./shared";

// Lists and tags (R14). Members and tagged contacts open the contact list with a filter.

interface Item {
  id: number;
  name: string;
}

function CreateForm({
  label,
  placeholder,
  pending,
  error,
  onCreate,
}: {
  label: string;
  placeholder: string;
  pending: boolean;
  error: unknown;
  onCreate: (name: string, reset: () => void) => void;
}) {
  const [name, setName] = useState("");
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim(), () => setName(""));
  }
  const id = `create-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <form className="flex flex-col gap-2" onSubmit={onSubmit}>
      <FormError message={errorText(error)} />
      <div className="flex max-w-[480px] items-end gap-2">
        <Field id={id} label={label} className="flex-1">
          <Input
            id={id}
            value={name}
            maxLength={100}
            placeholder={placeholder}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={pending || !name.trim()}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Create
        </Button>
      </div>
    </form>
  );
}

function RenameDialog({
  item,
  title,
  pending,
  error,
  onClose,
  onRename,
}: {
  item: Item | null;
  title: string;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onRename: (id: number, name: string) => void;
}) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!item) return;
    onRename(item.id, String(new FormData(event.currentTarget).get("name")).trim());
  }
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader title={title} />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(error)} />
          <Field id="rename-item" label="Name">
            <Input
              id="rename-item"
              name="name"
              required
              maxLength={100}
              defaultValue={item?.name}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useAudienceMutations(kind: "lists" | "tags") {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
  const create = useMutation({
    mutationFn: (name: string): Promise<unknown> =>
      kind === "lists"
        ? unwrap(api.POST("/lists", { body: { name } }))
        : unwrap(api.POST("/tags", { body: { name } })),
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }): Promise<unknown> =>
      kind === "lists"
        ? unwrap(api.PATCH("/lists/{id}", { params: { path: { id } }, body: { name } }))
        : unwrap(api.PATCH("/tags/{id}", { params: { path: { id } }, body: { name } })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number): Promise<unknown> =>
      kind === "lists"
        ? unwrap(api.DELETE("/lists/{id}", { params: { path: { id } } }))
        : unwrap(api.DELETE("/tags/{id}", { params: { path: { id } } })),
    onSuccess: refresh,
  });
  return { create, rename, remove };
}

export function ListsPage() {
  const { current } = useCurrentWorkspace();
  const lists = useQuery(listsQuery(current.id));
  const { create, rename, remove } = useAudienceMutations("lists");
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const items = lists.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop title="Contacts" description="Your audience, with lists, tags, and consent." />
      <div className="flex flex-col gap-6">
        <ContactsNav />
        <CreateForm
          label="New list"
          placeholder="For example, Course students"
          pending={create.isPending}
          error={create.error}
          onCreate={(name, reset) => create.mutate(name, { onSuccess: reset })}
        />
        {lists.isPending ? (
          <div className="h-32 rounded-xl border border-border bg-muted" />
        ) : items.length === 0 ? (
          <EmptyState icon={ListIcon} title="No lists yet">
            A list groups contacts who get the same campaigns. Each member keeps a status, so an
            unsubscribe from one list stays on record.
          </EmptyState>
        ) : (
          <Table aria-label="Lists">
            <thead>
              <tr>
                <TableHead>List</TableHead>
                <TableHead>Subscribed</TableHead>
                <TableHead>Unsubscribed</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {items.map((list) => (
                <TableRow key={list.id} data-testid="list-row">
                  <TableCell className="font-medium">
                    <Link to="/contacts" search={{ listId: list.id }} className="hover:underline">
                      {list.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Figure value={list.subscribed} />
                  </TableCell>
                  <TableCell>
                    <Figure value={list.unsubscribed} className="text-muted-foreground" />
                  </TableCell>
                  <TableCell className="figure text-muted-foreground">
                    {formatDate(list.createdAt)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(list)}>
                      Rename<span className="sr-only"> {list.name}</span>
                    </Button>
                    <Button variant="destructive-ghost" size="sm" onClick={() => setDeleting(list)}>
                      Delete<span className="sr-only"> {list.name}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      <RenameDialog
        key={renaming?.id}
        item={renaming}
        title="Rename list"
        pending={rename.isPending}
        error={rename.error}
        onClose={() => {
          rename.reset();
          setRenaming(null);
        }}
        onRename={(id, name) => rename.mutate({ id, name }, { onSuccess: () => setRenaming(null) })}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "list"}?`}
        description={
          errorText(remove.error) ??
          "The list and its memberships go away. The contacts stay, with their tags and any unsubscribe from every list."
        }
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() =>
          deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }
      />
    </div>
  );
}

export function TagsPage() {
  const { current } = useCurrentWorkspace();
  const tags = useQuery(tagsQuery(current.id));
  const { create, rename, remove } = useAudienceMutations("tags");
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const items = tags.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop title="Contacts" description="Your audience, with lists, tags, and consent." />
      <div className="flex flex-col gap-6">
        <ContactsNav />
        <CreateForm
          label="New tag"
          placeholder="For example, Course 101"
          pending={create.isPending}
          error={create.error}
          onCreate={(name, reset) => create.mutate(name, { onSuccess: reset })}
        />
        {tags.isPending ? (
          <div className="h-32 rounded-xl border border-border bg-muted" />
        ) : items.length === 0 ? (
          <EmptyState icon={TagIcon} title="No tags yet">
            Tags mark contacts, for example by course. Imports and the API can add them too.
          </EmptyState>
        ) : (
          <Table aria-label="Tags">
            <thead>
              <tr>
                <TableHead>Tag</TableHead>
                <TableHead>Contacts</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {items.map((tag) => (
                <TableRow key={tag.id} data-testid="tag-row">
                  <TableCell className="font-medium">
                    <Link to="/contacts" search={{ tagId: tag.id }} className="hover:underline">
                      {tag.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Figure value={tag.contacts} />
                  </TableCell>
                  <TableCell className="figure text-muted-foreground">
                    {formatDate(tag.createdAt)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(tag)}>
                      Rename<span className="sr-only"> {tag.name}</span>
                    </Button>
                    <Button variant="destructive-ghost" size="sm" onClick={() => setDeleting(tag)}>
                      Delete<span className="sr-only"> {tag.name}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      <RenameDialog
        key={renaming?.id}
        item={renaming}
        title="Rename tag"
        pending={rename.isPending}
        error={rename.error}
        onClose={() => {
          rename.reset();
          setRenaming(null);
        }}
        onRename={(id, name) => rename.mutate({ id, name }, { onSuccess: () => setRenaming(null) })}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "tag"}?`}
        description={
          errorText(remove.error) ?? "The tag comes off every contact. The contacts stay."
        }
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() =>
          deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }
      />
    </div>
  );
}
