import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "@/api/client";
import { type ContactFilters, listsQuery, tagsQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, Figure } from "./shared";

// Bulk changes on the Contacts page (contacts.bulk). The owner selects contacts on the
// loaded pages, or every contact that matches the filters, then adds them to a list or a
// tag, or removes them from it.

/** The contacts that a bulk change applies to. */
export type Selection = { mode: "ids"; ids: ReadonlySet<number> } | { mode: "all" };

export const NO_SELECTION: Selection = { mode: "ids", ids: new Set() };

export type BulkAction = "add_to_list" | "remove_from_list" | "add_tag" | "remove_tag";

const ACTIONS: { action: BulkAction; label: string; title: string }[] = [
  { action: "add_to_list", label: "Add to list", title: "Add to a list" },
  { action: "add_tag", label: "Add tag", title: "Add a tag" },
  { action: "remove_from_list", label: "Remove from list", title: "Remove from a list" },
  { action: "remove_tag", label: "Remove tag", title: "Remove a tag" },
];

/** The current filters without empty values, as the API takes them. */
export function filtersBody(filters: ContactFilters) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
  ) as ContactFilters;
}

function plural(count: number, word = "contact") {
  return `${count.toLocaleString()} ${count === 1 ? word : `${word}s`}`;
}

export function BulkBar({
  selection,
  selectedCount,
  loadedCount,
  matchingCount,
  filtered,
  onSelectAll,
  onClear,
  onAction,
}: {
  selection: Selection;
  selectedCount: number;
  loadedCount: number;
  matchingCount: number | undefined;
  filtered: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (action: BulkAction) => void;
}) {
  const canSelectAll =
    selection.mode === "ids" &&
    selectedCount === loadedCount &&
    matchingCount !== undefined &&
    matchingCount > loadedCount;
  return (
    <section
      aria-label="Selected contacts"
      data-testid="bulk-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/40 px-4 py-2.5"
    >
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" aria-live="polite">
        <span className="font-medium" data-testid="bulk-count">
          {selection.mode === "all" ? (
            <>
              All <Figure value={selectedCount} />{" "}
              {filtered ? "contacts that match the filters" : "contacts"} are selected.
            </>
          ) : (
            <>
              <Figure value={selectedCount} /> selected
            </>
          )}
        </span>
        {canSelectAll ? (
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2"
            onClick={onSelectAll}
          >
            {filtered
              ? `Select all ${matchingCount.toLocaleString()} that match`
              : `Select all ${matchingCount.toLocaleString()} contacts`}
          </button>
        ) : null}
        <button
          type="button"
          className="cursor-pointer text-muted-foreground underline underline-offset-2"
          onClick={onClear}
        >
          Clear selection
        </button>
      </p>
      <div className="ml-auto flex flex-wrap gap-2">
        {ACTIONS.map((item) => (
          <Button
            key={item.action}
            variant="outline"
            size="sm"
            onClick={() => onAction(item.action)}
          >
            {item.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

function resultMessage(
  action: BulkAction,
  name: string,
  result: { matched: number; changed: number },
): string {
  const rest = result.matched - result.changed;
  switch (action) {
    case "add_to_list":
      return `Added ${plural(result.changed)} to ${name}.${rest > 0 ? ` ${plural(rest)} were in the list already.` : ""}`;
    case "remove_from_list":
      return `Removed ${plural(result.changed)} from ${name}.`;
    case "add_tag":
      return `Tagged ${plural(result.changed)} with ${name}.${rest > 0 ? ` ${plural(rest)} had the tag already.` : ""}`;
    case "remove_tag":
      return `Removed the tag ${name} from ${plural(result.changed)}.`;
  }
}

export function BulkDialog({
  action,
  selection,
  selectedCount,
  filters,
  onOpenChange,
  onDone,
}: {
  action: BulkAction | null;
  selection: Selection;
  selectedCount: number;
  filters: ContactFilters;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const lists = useQuery(listsQuery(current.id));
  const tags = useQuery(tagsQuery(current.id));
  const [listId, setListId] = useState("");
  const [tagId, setTagId] = useState("");
  const [tagName, setTagName] = useState("");

  const run = useMutation({
    mutationFn: (body: {
      action: BulkAction;
      listId?: number;
      tagId?: number;
      tagName?: string;
      name: string;
    }) => {
      const { name: _name, ...rest } = body;
      return unwrap(
        api.POST("/contacts/bulk", {
          body: {
            ...rest,
            ...(selection.mode === "all"
              ? { filters: filtersBody(filters) }
              : { contactIds: [...selection.ids] }),
          },
        }),
      );
    },
    onSuccess: async (result, body) => {
      toast(resultMessage(body.action, body.name, result));
      reset();
      onDone();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ws", current.id, "contacts"] }),
        queryClient.invalidateQueries({ queryKey: ["ws", current.id, "lists"] }),
        queryClient.invalidateQueries({ queryKey: ["ws", current.id, "tags"] }),
      ]);
    },
  });

  function reset() {
    setListId("");
    setTagId("");
    setTagName("");
    run.reset();
  }

  const item = ACTIONS.find((candidate) => candidate.action === action);
  const forList = action === "add_to_list" || action === "remove_from_list";
  const listItems = lists.data?.items ?? [];
  const tagItems = tags.data?.items ?? [];
  const who =
    selection.mode === "all" ? (
      <>
        every contact that matches the current filters (<Figure value={selectedCount} />)
      </>
    ) : (
      plural(selectedCount, "selected contact")
    );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    if (forList) {
      const list = listItems.find((candidate) => String(candidate.id) === listId);
      if (list) run.mutate({ action, listId: list.id, name: list.name });
    } else if (action === "add_tag") {
      const name = tagName.trim();
      if (name) run.mutate({ action, tagName: name, name });
    } else {
      const tag = tagItems.find((candidate) => String(candidate.id) === tagId);
      if (tag) run.mutate({ action, tagId: tag.id, name: tag.name });
    }
  }

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader title={item?.title ?? ""} description={<>The change applies to {who}.</>} />
        <form className="flex flex-col gap-5" onSubmit={onSubmit} aria-label={item?.title}>
          <FormError message={errorText(run.error)} />
          {forList ? (
            <Field
              id="bulk-list"
              label="List"
              required
              hint={
                action === "add_to_list"
                  ? "A contact who unsubscribed from the list stays unsubscribed. The welcome series of the list does not start."
                  : "Envelopen keeps the record of each contact who unsubscribed from the list."
              }
            >
              <NativeSelect
                id="bulk-list"
                required
                value={listId}
                onChange={(event) => setListId(event.target.value)}
                aria-describedby="bulk-list-hint"
              >
                <option value="">Select a list</option>
                {listItems.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : action === "add_tag" ? (
            <Field
              id="bulk-tag-name"
              label="Tag"
              required
              hint="Select a tag or type a new one. Envelopen creates a new tag."
            >
              <Input
                id="bulk-tag-name"
                required
                maxLength={60}
                list="bulk-tag-options"
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                aria-describedby="bulk-tag-name-hint"
              />
              <datalist id="bulk-tag-options">
                {tagItems.map((tag) => (
                  <option key={tag.id} value={tag.name} />
                ))}
              </datalist>
            </Field>
          ) : (
            <Field id="bulk-tag" label="Tag" required>
              <NativeSelect
                id="bulk-tag"
                required
                value={tagId}
                onChange={(event) => setTagId(event.target.value)}
              >
                <option value="">Select a tag</option>
                {tagItems.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" pending={run.isPending}>
              {item?.label ?? "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
