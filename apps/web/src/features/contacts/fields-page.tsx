import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ApiRequestError, api, type Schemas, unwrap } from "@/api/client";
import { fieldsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Pill } from "@/components/ui/pill";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { ContactsNav, errorText, PageTop } from "./shared";

// Custom fields (R13). A choice field has options with a stable id, so a rename changes
// only the label. An option that contacts hold is deleted only with a merge into another
// option.

export type ContactField = Schemas["ContactField"];
type FieldType = ContactField["type"];
type Option = ContactField["options"][number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes or no",
  choice: "Single choice",
  multi: "Multiple choice",
};

const isChoice = (type: FieldType) => type === "choice" || type === "multi";

type Preference = ContactField["preference"];

export const PREFERENCE_LABELS: Record<Preference, string> = {
  hidden: "Hidden",
  read_only: "Read only",
  editable: "Subscriber can change it",
};

function useRefreshFields() {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  return () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });
}

/** A key from a label: "Favorite topic" gives "favorite_topic". */
function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");
  return key.slice(0, 40);
}

function CreateFieldForm() {
  const refresh = useRefreshFields();
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/fields", {
          body: {
            key,
            label: label.trim(),
            type,
            ...(isChoice(type)
              ? {
                  options: options
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                }
              : {}),
          },
        }),
      ),
    onSuccess: async (field) => {
      setLabel("");
      setKey("");
      setKeyEdited(false);
      setOptions("");
      setType("text");
      await refresh();
      toast(`Field "${field.label}" created.`);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (label.trim() && key) create.mutate();
  }

  return (
    <form
      aria-labelledby="new-field-title"
      className="flex max-w-[640px] flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={onSubmit}
    >
      <h2 id="new-field-title" className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
        New field
      </h2>
      <FormError message={errorText(create.error)} />
      <div className="flex flex-wrap gap-3">
        <Field id="field-label" label="Label" className="min-w-[200px] flex-1">
          <Input
            id="field-label"
            value={label}
            maxLength={100}
            placeholder="For example, Interests"
            onChange={(event) => {
              setLabel(event.target.value);
              if (!keyEdited) setKey(keyFromLabel(event.target.value));
            }}
          />
        </Field>
        <Field
          id="field-key"
          label="Merge tag"
          hint="Lowercase letters, digits, and underscores."
          className="min-w-[180px] flex-1"
        >
          <Input
            id="field-key"
            value={key}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            aria-describedby="field-key-hint"
            onChange={(event) => {
              setKeyEdited(true);
              setKey(event.target.value);
            }}
          />
        </Field>
        <Field id="field-type" label="Type" className="min-w-[160px]">
          <NativeSelect
            id="field-type"
            value={type}
            onChange={(event) => setType(event.target.value as FieldType)}
          >
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((value) => (
              <option key={value} value={value}>
                {FIELD_TYPE_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {isChoice(type) ? (
        <Field
          id="field-options"
          label="Options"
          hint="One option on each line. A label cannot contain a comma."
        >
          <Textarea
            id="field-options"
            value={options}
            className="min-h-24"
            placeholder={"Design\nData\nWriting"}
            aria-describedby="field-options-hint"
            onChange={(event) => setOptions(event.target.value)}
          />
        </Field>
      ) : null}
      <div>
        <Button type="submit" pending={create.isPending} disabled={!label.trim() || !key}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Create field
        </Button>
      </div>
    </form>
  );
}

function RenameOptionDialog({
  field,
  option,
  onClose,
}: {
  field: ContactField;
  option: Option | null;
  onClose: () => void;
}) {
  const refresh = useRefreshFields();
  const rename = useMutation({
    mutationFn: (label: string) =>
      unwrap(
        api.PATCH("/fields/{id}/options/{optionId}", {
          params: { path: { id: field.id, optionId: option?.id ?? 0 } },
          body: { label },
        }),
      ),
    onSuccess: async (_data, label) => {
      await refresh();
      onClose();
      toast(`Option renamed to "${label}". Contacts keep it.`);
    },
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    rename.mutate(String(new FormData(event.currentTarget).get("label") ?? "").trim());
  }
  return (
    <Dialog open={option !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader
          title="Rename option"
          description="Contacts keep the option. Merge tags and forms show the new label."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(rename.error)} />
          <Field id="rename-option" label="Label">
            <Input
              id="rename-option"
              name="label"
              required
              maxLength={100}
              defaultValue={option?.label}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
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

function DeleteOptionDialog({
  field,
  option,
  onClose,
}: {
  field: ContactField;
  option: Option | null;
  onClose: () => void;
}) {
  const refresh = useRefreshFields();
  const [mergeInto, setMergeInto] = useState("");
  const others = field.options.filter((item) => item.id !== option?.id);
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/fields/{id}/options/{optionId}", {
          params: {
            path: { id: field.id, optionId: option?.id ?? 0 },
            query: mergeInto ? { mergeInto: Number(mergeInto) } : {},
          },
        }),
      ),
    onSuccess: async (data) => {
      await refresh();
      onClose();
      const target = others.find((item) => String(item.id) === mergeInto);
      toast(
        data.merged > 0 && target
          ? `Option "${option?.label}" deleted. ${data.merged} ${data.merged === 1 ? "contact moved" : "contacts moved"} to "${target.label}".`
          : `Option "${option?.label}" deleted.`,
      );
    },
  });
  const inUse =
    remove.error instanceof ApiRequestError && remove.error.code === "conflict" && !mergeInto;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    remove.mutate();
  }

  return (
    <Dialog open={option !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          title={`Delete ${option?.label ?? "option"}?`}
          description="Contacts that hold this option can move to another option. You cannot undo this."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <FormError message={errorText(remove.error)} />
          <Field
            id="merge-into"
            label="Move its contacts to"
            hint={
              inUse
                ? "Pick an option. Envelopen deletes an option in use only with a merge."
                : "Optional when no contact holds the option."
            }
          >
            <NativeSelect
              id="merge-into"
              value={mergeInto}
              aria-describedby="merge-into-hint"
              aria-invalid={inUse || undefined}
              onChange={(event) => setMergeInto(event.target.value)}
            >
              <option value="">Do not move</option>
              {others.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" pending={remove.isPending}>
              {mergeInto ? "Merge and delete" : "Delete option"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionsEditor({ field }: { field: ContactField }) {
  const refresh = useRefreshFields();
  const [label, setLabel] = useState("");
  const [renaming, setRenaming] = useState<Option | null>(null);
  const [deleting, setDeleting] = useState<Option | null>(null);
  const add = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.POST("/fields/{id}/options", {
          params: { path: { id: field.id } },
          body: { label: value },
        }),
      ),
    onSuccess: async () => {
      setLabel("");
      await refresh();
    },
  });
  const reorder = useMutation({
    mutationFn: (optionIds: number[]) =>
      unwrap(
        api.PUT("/fields/{id}/options", {
          params: { path: { id: field.id } },
          body: { optionIds },
        }),
      ),
    onSuccess: refresh,
  });

  function move(index: number, by: -1 | 1) {
    const ids = field.options.map((option) => option.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    reorder.mutate(ids);
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    if (label.trim()) add.mutate(label.trim());
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError message={errorText(add.error ?? reorder.error)} />
      {field.options.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">No options yet.</p>
      ) : (
        <ol
          aria-label={`Options of ${field.label}`}
          className="m-0 flex list-none flex-col rounded-lg border border-border p-0"
        >
          {field.options.map((option, index) => (
            <li
              key={option.id}
              data-testid="option-row"
              className="flex items-center gap-2 border-b border-hairline py-1.5 pr-1.5 pl-3 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-[13px]">{option.label}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${option.label} up`}
                disabled={index === 0 || reorder.isPending}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${option.label} down`}
                disabled={index === field.options.length - 1 || reorder.isPending}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon className="size-3.5" aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRenaming(option)}>
                Rename<span className="sr-only"> {option.label}</span>
              </Button>
              <Button variant="destructive-ghost" size="sm" onClick={() => setDeleting(option)}>
                Delete<span className="sr-only"> {option.label}</span>
              </Button>
            </li>
          ))}
        </ol>
      )}
      <form className="flex max-w-[420px] gap-2" onSubmit={onAdd}>
        <Input
          aria-label={`New option for ${field.label}`}
          placeholder="Add an option"
          maxLength={100}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" variant="outline" pending={add.isPending} disabled={!label.trim()}>
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Add
        </Button>
      </form>
      <RenameOptionDialog
        key={`rename-${renaming?.id}`}
        field={field}
        option={renaming}
        onClose={() => setRenaming(null)}
      />
      <DeleteOptionDialog
        key={`delete-${deleting?.id}`}
        field={field}
        option={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

/** What the preference page shows of the field. It saves when the value changes. */
function PreferenceSetting({ field }: { field: ContactField }) {
  const refresh = useRefreshFields();
  const id = `field-${field.id}-preference`;
  const change = useMutation({
    mutationFn: (preference: Preference) =>
      unwrap(
        api.PATCH("/fields/{id}", {
          params: { path: { id: field.id } },
          body: { preference },
        }),
      ),
    onSuccess: async (result) => {
      await refresh();
      toast(`The preference page setting of "${result.label}" is saved.`);
    },
  });
  return (
    <Field
      id={id}
      label="On the preference page"
      hint="Each email links to this page. Subscribers can see or change their own answer there."
      error={errorText(change.error)}
      className="max-w-[420px]"
    >
      <NativeSelect
        id={id}
        value={field.preference}
        disabled={change.isPending}
        aria-describedby={`${id}-hint`}
        onChange={(event) => change.mutate(event.target.value as Preference)}
      >
        {(Object.keys(PREFERENCE_LABELS) as Preference[]).map((value) => (
          <option key={value} value={value}>
            {PREFERENCE_LABELS[value]}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function FieldCard({ field }: { field: ContactField }) {
  return (
    <section
      aria-labelledby={`field-${field.id}-title`}
      data-testid="field-card"
      className="flex flex-col gap-3 border-b border-hairline pb-6 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <h2
          id={`field-${field.id}-title`}
          className="m-0 text-[15px] font-semibold tracking-[-0.01em]"
        >
          {field.label}
        </h2>
        <Pill tone={isChoice(field.type) ? "lavender" : "teal"}>
          {FIELD_TYPE_LABELS[field.type]}
        </Pill>
        <code className="font-mono text-xs text-muted-foreground">{`{{ ${field.key} }}`}</code>
      </div>
      {isChoice(field.type) ? <OptionsEditor field={field} /> : null}
      <PreferenceSetting field={field} />
    </section>
  );
}

export function FieldsPage() {
  const { current } = useCurrentWorkspace();
  const fields = useQuery(fieldsQuery(current.id));
  const items = fields.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <PageTop title="Contacts" description="Your audience, with lists, tags, and consent." />
      <div className="flex flex-col gap-6">
        <ContactsNav />
        <CreateFieldForm />
        {fields.isError ? (
          <p role="alert" className="m-0 text-[13px] text-muted-foreground">
            {errorText(fields.error)}
          </p>
        ) : fields.isPending ? (
          <TableSkeleton label="Loading the fields" rows={3} columns={2} />
        ) : items.length === 0 ? (
          <EmptyState icon={SlidersHorizontalIcon} title="No custom fields yet">
            A field holds more about a contact, for example a course or interests. Use it in a merge
            tag. An import and the API can add text fields too.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-6">
            {items.map((field) => (
              <FieldCard key={field.id} field={field} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
