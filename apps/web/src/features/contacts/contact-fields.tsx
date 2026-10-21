import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { fieldsQuery } from "@/api/queries";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import type { ContactField } from "./fields-page";
import { errorText } from "./shared";

// The custom fields of one contact (R13). A choice field stores option ids: one id for a
// single choice, a JSON array of ids for a multiple choice. The page shows the labels.

type Contact = Schemas["Contact"];
type Draft = Record<string, string | number[]>;

/** The option ids in a stored choice value. */
export function storedIds(value: string | null | undefined): number[] {
  if (!value) return [];
  if (/^\d+$/.test(value)) return [Number(value)];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

/** The text of a stored value: labels in option order for a choice field. */
export function fieldValueText(field: ContactField | undefined, value: string | null) {
  if (!field || (field.type !== "choice" && field.type !== "multi")) return value;
  const ids = new Set(storedIds(value));
  const labels = field.options.filter((option) => ids.has(option.id)).map((option) => option.label);
  return labels.length === 0 ? null : labels.join(", ");
}

function draftOf(fields: readonly ContactField[], contact: Contact): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const value = contact.fields[field.key] ?? null;
    if (field.type === "multi") draft[field.key] = storedIds(value);
    else if (field.type === "choice") draft[field.key] = storedIds(value)[0]?.toString() ?? "";
    else draft[field.key] = value ?? "";
  }
  return draft;
}

function EditFieldsDialog({
  contact,
  fields,
  open,
  onOpenChange,
}: {
  contact: Contact;
  fields: readonly ContactField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { current } = useCurrentWorkspace();
  const [initial] = useState<Draft>(() => draftOf(fields, contact));
  const [draft, setDraft] = useState<Draft>(initial);
  const save = useMutation({
    mutationFn: () => {
      // Only the changed fields: one call takes at most 20.
      const body: Record<string, string | number | number[] | null> = {};
      for (const field of fields) {
        const value = draft[field.key];
        if (JSON.stringify(value) === JSON.stringify(initial[field.key])) continue;
        if (Array.isArray(value)) body[field.key] = value.length > 0 ? value : null;
        else if (field.type === "choice") body[field.key] = value ? Number(value) : null;
        else body[field.key] = value?.trim() ? value.trim() : null;
      }
      return unwrap(
        api.PATCH("/contacts/{id}", {
          params: { path: { id: contact.id } },
          body: { fields: body },
        }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "contacts"] });
      onOpenChange(false);
      toast("Custom fields saved.");
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) save.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[520px]">
        <DialogHeader title="Edit custom fields" description={contact.email} />
        <form className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto" onSubmit={onSubmit}>
          <FormError message={errorText(save.error)} />
          {fields.map((field) => {
            const id = `edit-field-${field.id}`;
            const value = draft[field.key];
            if (field.type === "multi") {
              const chosen = new Set(Array.isArray(value) ? value : []);
              return (
                <fieldset key={field.id} className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 p-0 text-[13px] font-medium">{field.label}</legend>
                  {field.options.map((option) => (
                    <div key={option.id} className="flex items-start gap-2.5">
                      <Checkbox
                        id={`${id}-${option.id}`}
                        checked={chosen.has(option.id)}
                        onCheckedChange={(checked) => {
                          const next = new Set(chosen);
                          if (checked === true) next.add(option.id);
                          else next.delete(option.id);
                          setDraft({ ...draft, [field.key]: [...next] });
                        }}
                      />
                      <Label htmlFor={`${id}-${option.id}`} className="cursor-pointer font-normal">
                        {option.label}
                      </Label>
                    </div>
                  ))}
                </fieldset>
              );
            }
            if (field.type === "choice") {
              return (
                <fieldset key={field.id} className="m-0 flex flex-col border-0 p-0">
                  <legend className="mb-2 p-0 text-[13px] font-medium">{field.label}</legend>
                  <RadioGroup
                    aria-label={field.label}
                    value={typeof value === "string" ? value : ""}
                    onValueChange={(next) => setDraft({ ...draft, [field.key]: next })}
                  >
                    <div className="flex items-start gap-2.5">
                      <RadioGroupItem id={`${id}-none`} value="" />
                      <Label
                        htmlFor={`${id}-none`}
                        className="cursor-pointer font-normal text-muted-foreground"
                      >
                        No answer
                      </Label>
                    </div>
                    {field.options.map((option) => (
                      <div key={option.id} className="flex items-start gap-2.5">
                        <RadioGroupItem id={`${id}-${option.id}`} value={String(option.id)} />
                        <Label
                          htmlFor={`${id}-${option.id}`}
                          className="cursor-pointer font-normal"
                        >
                          {option.label}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </fieldset>
              );
            }
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                <Input
                  id={id}
                  maxLength={1000}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              </div>
            );
          })}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The custom fields of a contact, with labels for choice values, and an edit dialog. */
export function ContactFieldsSection({ contact }: { contact: Contact }) {
  const { current } = useCurrentWorkspace();
  const fields = useQuery(fieldsQuery(current.id));
  const [editing, setEditing] = useState(false);
  const items = fields.data?.items ?? [];
  const byKey = new Map(items.map((field) => [field.key, field]));
  // Every field of the workspace, and any stored key that the field list does not have.
  const keys = [
    ...items.map((field) => field.key),
    ...Object.keys(contact.fields).filter((key) => !byKey.has(key)),
  ];

  return (
    <section aria-labelledby="fields-title" className="flex flex-col gap-2">
      <SectionHeader
        id="fields-title"
        title="Custom fields"
        aside={
          items.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit fields
            </Button>
          ) : null
        }
      />
      {fields.isError ? (
        <p role="alert" className="m-0 text-[13px] text-muted-foreground">
          The fields did not load.
        </p>
      ) : keys.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">No custom fields.</p>
      ) : (
        <dl className="m-0 flex flex-col">
          {keys.map((key) => {
            const field = byKey.get(key);
            const text = fieldValueText(field, contact.fields[key] ?? null);
            return (
              <div
                key={key}
                className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-hairline py-2.5 last:border-b-0"
              >
                <dt className="text-[13px] text-muted-foreground">{field?.label ?? key}</dt>
                <dd className="m-0 min-w-0 text-[13px] break-words">
                  {text ?? <span className="text-muted-foreground">Empty</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {editing ? (
        <EditFieldsDialog
          contact={contact}
          fields={items}
          open={editing}
          onOpenChange={setEditing}
        />
      ) : null}
    </section>
  );
}
