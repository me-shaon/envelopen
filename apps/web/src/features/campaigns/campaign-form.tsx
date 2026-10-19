import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { domainsQuery, listsQuery, tagsQuery, templatesQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { CAMPAIGN_TYPES } from "./shared";

// The campaign draft form (R31): content from a template, the sender, the audience by
// lists and tags with exclusions, the campaign type (AE1), and tracking. Saving a draft
// increments its version, so a confirm token from before goes stale (R68).

type Audience = Schemas["CampaignAudience"];
type CampaignType = Schemas["Campaign"]["type"];

interface Draft {
  name: string;
  type: CampaignType;
  templateId: number | null;
  subject: string;
  preheader: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  audience: Audience;
  trackOpens: boolean;
  trackClicks: boolean;
}

const EMPTY_AUDIENCE: Audience = { listIds: [], tagIds: [], excludeListIds: [], excludeTagIds: [] };

function draftOf(campaign: Schemas["Campaign"] | undefined): Draft {
  return {
    name: campaign?.name ?? "",
    type: campaign?.type ?? "regular",
    templateId: campaign?.templateId ?? null,
    subject: campaign?.subject ?? "",
    preheader: campaign?.preheader ?? "",
    fromName: campaign?.fromName ?? "",
    fromEmail: campaign?.fromEmail ?? "",
    replyTo: campaign?.replyTo ?? "",
    audience: campaign?.audience ?? EMPTY_AUDIENCE,
    trackOpens: campaign?.trackOpens ?? true,
    trackClicks: campaign?.trackClicks ?? true,
  };
}

function toggle(ids: number[], id: number, on: boolean): number[] {
  return on ? [...new Set([...ids, id])] : ids.filter((item) => item !== id);
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 border-t border-hairline pt-6 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-1">
        <h2 id={id} className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {hint ? <p className="m-0 text-[13px] text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function PickList({
  legend,
  items,
  selected,
  onChange,
  idPrefix,
  empty,
}: {
  legend: string;
  items: { id: number; name: string }[];
  selected: number[];
  onChange: (ids: number[]) => void;
  idPrefix: string;
  empty: ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium">{legend}</legend>
      {items.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{empty}</p> : null}
      {items.map((item) => {
        const id = `${idPrefix}-${item.id}`;
        return (
          <div key={item.id} className="flex items-center gap-2.5">
            <Checkbox
              id={id}
              checked={selected.includes(item.id)}
              onCheckedChange={(checked) => onChange(toggle(selected, item.id, checked === true))}
            />
            <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate font-normal">
              {item.name}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

export function CampaignForm({
  campaign,
  aside,
}: {
  campaign?: Schemas["Campaign"];
  /** Shown next to the save button, for example "Review and send". */
  aside?: ReactNode;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery(templatesQuery(current.id));
  const lists = useQuery(listsQuery(current.id));
  const tags = useQuery(tagsQuery(current.id));
  const domains = useQuery(domainsQuery(current.id));
  const [draft, setDraft] = useState<Draft>(() => draftOf(campaign));
  const [showExclusions, setShowExclusions] = useState(
    () =>
      (campaign?.audience.excludeListIds.length ?? 0) +
        (campaign?.audience.excludeTagIds.length ?? 0) >
      0,
  );
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  const setAudience = (key: keyof Audience, ids: number[]) =>
    setDraft((prev) => ({ ...prev, audience: { ...prev.audience, [key]: ids } }));

  const firstDomain = domains.data?.items[0]?.domain;
  const body = {
    name: draft.name,
    type: draft.type,
    templateId: draft.templateId,
    subject: draft.subject || null,
    preheader: draft.preheader || null,
    fromName: draft.fromName || null,
    fromEmail: draft.fromEmail || null,
    replyTo: draft.replyTo || null,
    audience: draft.audience,
    trackOpens: draft.trackOpens,
    trackClicks: draft.trackClicks,
  };

  const save = useMutation({
    mutationFn: async () =>
      campaign
        ? unwrap(api.PATCH("/campaigns/{id}", { params: { path: { id: campaign.id } }, body }))
        : unwrap(api.POST("/campaigns", { body })),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "campaigns"] });
      setDraft(draftOf(saved));
      if (!campaign) {
        await navigate({ to: "/campaigns/$campaignId", params: { campaignId: String(saved.id) } });
      }
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (draft.name.trim()) save.mutate();
  }

  const templateItems = templates.data?.items ?? [];
  const changed = JSON.stringify(draftOf(campaign)) !== JSON.stringify(draft);

  return (
    <form className="flex max-w-[720px] flex-col gap-8" onSubmit={onSubmit} aria-label="Campaign">
      <FormError message={errorText(save.error)} />
      <Section id="campaign-basics" title="Campaign">
        <Field id="campaign-name" label="Campaign name" hint="Only you see it.">
          <Input
            id="campaign-name"
            required
            maxLength={200}
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Course launch, October"
          />
        </Field>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-[13px] font-medium">Type</legend>
          <RadioGroup
            value={draft.type}
            onValueChange={(value) => set("type", value as CampaignType)}
          >
            {(Object.keys(CAMPAIGN_TYPES) as CampaignType[]).map((type) => (
              <div key={type} className="flex items-start gap-2.5">
                <RadioGroupItem value={type} id={`campaign-type-${type}`} />
                <Label
                  htmlFor={`campaign-type-${type}`}
                  className="flex cursor-pointer flex-col items-start gap-0.5 font-normal"
                >
                  <span className="font-medium">{CAMPAIGN_TYPES[type].label}</span>
                  <span className="text-xs text-muted-foreground">
                    {CAMPAIGN_TYPES[type].detail}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      </Section>

      <Section
        id="campaign-content"
        title="Content"
        hint="The campaign keeps its own copy of the template. Save again to take the template's latest version."
      >
        <Field id="campaign-template" label="Template">
          <NativeSelect
            id="campaign-template"
            value={draft.templateId ?? ""}
            onChange={(event) =>
              set("templateId", event.target.value ? Number(event.target.value) : null)
            }
          >
            <option value="">Choose a template</option>
            {templateItems.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {templateItems.length === 0 && !templates.isPending ? (
          <p className="m-0 text-xs text-muted-foreground">
            No templates yet.{" "}
            <Link to="/templates/$templateId" params={{ templateId: "new" }} className="underline">
              Write one
            </Link>
            .
          </p>
        ) : null}
        <Field
          id="campaign-subject"
          label="Subject"
          hint="Empty takes the template's subject. Merge tags work here."
        >
          <Input
            id="campaign-subject"
            maxLength={200}
            value={draft.subject}
            onChange={(event) => set("subject", event.target.value)}
          />
        </Field>
        <Field
          id="campaign-preheader"
          label="Preview text"
          hint="The line that inboxes show after the subject."
        >
          <Input
            id="campaign-preheader"
            maxLength={300}
            value={draft.preheader}
            onChange={(event) => set("preheader", event.target.value)}
          />
        </Field>
      </Section>

      <Section id="campaign-sender" title="Sender">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="campaign-from-name" label="From name">
            <Input
              id="campaign-from-name"
              maxLength={100}
              value={draft.fromName}
              onChange={(event) => set("fromName", event.target.value)}
              placeholder="Course Academy"
            />
          </Field>
          <Field
            id="campaign-from-email"
            label="From address"
            hint={
              firstDomain
                ? `On a sending domain, for example news@${firstDomain}.`
                : "Add a sending domain first."
            }
          >
            <Input
              id="campaign-from-email"
              type="email"
              value={draft.fromEmail}
              onChange={(event) => set("fromEmail", event.target.value)}
            />
          </Field>
        </div>
        <Field id="campaign-reply-to" label="Reply-To (optional)">
          <Input
            id="campaign-reply-to"
            type="email"
            value={draft.replyTo}
            onChange={(event) => set("replyTo", event.target.value)}
          />
        </Field>
      </Section>

      <Section
        id="campaign-audience"
        title="Audience"
        hint="Subscribed members of the lists and contacts with the tags. Envelopen leaves out suppressed and unsubscribed contacts."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <PickList
            legend="Lists"
            idPrefix="audience-list"
            items={lists.data?.items ?? []}
            selected={draft.audience.listIds}
            onChange={(ids) => setAudience("listIds", ids)}
            empty={
              <Link to="/contacts/lists" className="underline">
                Create a list
              </Link>
            }
          />
          <PickList
            legend="Tags"
            idPrefix="audience-tag"
            items={tags.data?.items ?? []}
            selected={draft.audience.tagIds}
            onChange={(ids) => setAudience("tagIds", ids)}
            empty="No tags yet."
          />
        </div>
        {showExclusions ? (
          <div className="grid gap-6 rounded-xl border border-border p-4 sm:grid-cols-2">
            <PickList
              legend="Leave out lists"
              idPrefix="exclude-list"
              items={lists.data?.items ?? []}
              selected={draft.audience.excludeListIds}
              onChange={(ids) => setAudience("excludeListIds", ids)}
              empty="No lists."
            />
            <PickList
              legend="Leave out tags"
              idPrefix="exclude-tag"
              items={tags.data?.items ?? []}
              selected={draft.audience.excludeTagIds}
              onChange={(ids) => setAudience("excludeTagIds", ids)}
              empty="No tags."
            />
          </div>
        ) : (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowExclusions(true)}>
              Leave out lists or tags
            </Button>
          </div>
        )}
      </Section>

      <Section
        id="campaign-tracking"
        title="Tracking"
        hint="Machine opens, such as Apple Mail Privacy Protection, count apart from human opens."
      >
        <div className="flex flex-col gap-2">
          {(
            [
              ["trackOpens", "Track opens"],
              ["trackClicks", "Track clicks"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center gap-2.5">
              <Checkbox
                id={`campaign-${key}`}
                checked={draft[key]}
                onCheckedChange={(checked) => set(key, checked === true)}
              />
              <Label htmlFor={`campaign-${key}`} className="cursor-pointer font-normal">
                {label}
              </Label>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-6">
        <Button
          type="submit"
          variant={campaign ? "outline" : "default"}
          disabled={save.isPending || !draft.name.trim() || (campaign !== undefined && !changed)}
        >
          {save.isPending
            ? "Saving..."
            : campaign
              ? changed
                ? "Save changes"
                : "Saved"
              : "Create draft"}
        </Button>
        {aside && !changed ? aside : null}
        {aside && changed ? (
          <span className="text-xs text-muted-foreground">Save the changes before you send.</span>
        ) : null}
      </div>
    </form>
  );
}
