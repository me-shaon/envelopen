import {
  SOCIAL_NETWORKS,
  type SocialLink,
  type SocialNetwork,
} from "@envelopen/email-render/blocks/types";
import type { Editor } from "@tiptap/core";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

// Settings of the selected atom block. Each change updates the node's attributes, so
// undo and redo work as for text.

const TITLES: Record<string, string> = {
  image: "Image",
  button: "Button",
  divider: "Divider",
  spacer: "Spacer",
  social: "Social links",
  footer: "Footer",
  html: "Raw HTML",
  mergeTag: "Merge tag",
};

const NETWORK_LABELS: Record<SocialNetwork, string> = {
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  github: "GitHub",
};

function AlignSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <Field id={id} label="Alignment">
      <NativeSelect
        id={id}
        value={String(value ?? "left")}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
      </NativeSelect>
    </Field>
  );
}

export function BlockSettings({
  editor,
  block,
  fields,
}: {
  editor: Editor;
  block: { type: string; attrs: Record<string, unknown> };
  /** Merge fields for the merge tag settings: key and label. */
  fields: { key: string; label: string }[];
}) {
  const { type, attrs } = block;
  const set = (values: Record<string, unknown>) =>
    editor.chain().updateAttributes(type, values).run();
  const text = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : "");
  const id = (key: string) => `block-${type}-${key}`;

  return (
    <section
      aria-labelledby="block-settings-title"
      className="flex flex-col gap-4 rounded-xl border border-border p-4"
      data-testid="block-settings"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="block-settings-title" className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
          {TITLES[type] ?? "Block"}
        </h2>
        <Button
          variant="destructive-ghost"
          size="icon-sm"
          onClick={() => editor.chain().focus().deleteSelection().run()}
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Delete the block</span>
        </Button>
      </div>

      {type === "image" ? (
        <>
          <Field id={id("src")} label="Image URL" hint="An https address. Uploads arrive later.">
            <Input
              id={id("src")}
              type="url"
              value={text("src")}
              placeholder="https://example.com/photo.png"
              onChange={(e) => set({ src: e.target.value })}
            />
          </Field>
          <Field id={id("alt")} label="Alt text">
            <Input
              id={id("alt")}
              value={text("alt")}
              onChange={(e) => set({ alt: e.target.value })}
            />
          </Field>
          <Field id={id("width")} label="Width in pixels">
            <Input
              id={id("width")}
              type="number"
              min={40}
              max={600}
              value={Number(attrs.width) || 600}
              onChange={(e) => set({ width: Number(e.target.value) })}
            />
          </Field>
          <Field id={id("href")} label="Link (optional)">
            <Input
              id={id("href")}
              type="url"
              value={text("href")}
              onChange={(e) => set({ href: e.target.value })}
            />
          </Field>
          <AlignSelect id={id("align")} value={attrs.align} onChange={(align) => set({ align })} />
        </>
      ) : null}

      {type === "button" ? (
        <>
          <Field id={id("label")} label="Label">
            <Input
              id={id("label")}
              value={text("label")}
              onChange={(e) => set({ label: e.target.value })}
            />
          </Field>
          <Field id={id("href")} label="Link">
            <Input
              id={id("href")}
              type="url"
              value={text("href")}
              onChange={(e) => set({ href: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id={id("background")} label="Background">
              <Input
                id={id("background")}
                type="color"
                className="h-9 p-1"
                value={text("background")}
                onChange={(e) => set({ background: e.target.value })}
              />
            </Field>
            <Field id={id("color")} label="Text">
              <Input
                id={id("color")}
                type="color"
                className="h-9 p-1"
                value={text("color")}
                onChange={(e) => set({ color: e.target.value })}
              />
            </Field>
          </div>
          <AlignSelect id={id("align")} value={attrs.align} onChange={(align) => set({ align })} />
        </>
      ) : null}

      {type === "spacer" ? (
        <Field id={id("height")} label="Height in pixels">
          <Input
            id={id("height")}
            type="number"
            min={4}
            max={160}
            value={Number(attrs.height) || 24}
            onChange={(e) => set({ height: Number(e.target.value) })}
          />
        </Field>
      ) : null}

      {type === "divider" ? (
        <p className="m-0 text-[13px] text-muted-foreground">A thin line between sections.</p>
      ) : null}

      {type === "social" ? (
        <SocialSettings
          links={Array.isArray(attrs.links) ? (attrs.links as SocialLink[]) : []}
          onChange={(links) => set({ links })}
          align={
            <AlignSelect
              id={id("align")}
              value={attrs.align}
              onChange={(align) => set({ align })}
            />
          }
        />
      ) : null}

      {type === "footer" ? (
        <Field
          id={id("text")}
          label="Footer text"
          hint="Your address and why people get this email. The unsubscribe and preference links are always added."
        >
          <Textarea
            id={id("text")}
            value={text("text")}
            onChange={(e) => set({ text: e.target.value })}
          />
        </Field>
      ) : null}

      {type === "mergeTag" ? (
        <>
          <Field id={id("field")} label="Field">
            <NativeSelect
              id={id("field")}
              value={text("field")}
              onChange={(e) => set({ field: e.target.value })}
            >
              {fields.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={id("fallback")}
            label="Fallback"
            hint="Shown when the contact has no value, for example “there” in “Hi there”."
          >
            <Input
              id={id("fallback")}
              value={text("fallback")}
              maxLength={80}
              onChange={(e) => set({ fallback: e.target.value.replaceAll('"', "") })}
            />
          </Field>
        </>
      ) : null}

      {type === "html" ? (
        <Field
          id={id("html")}
          label="HTML"
          hint="Scripts, event attributes, and javascript: links are removed when you save."
        >
          <Textarea
            id={id("html")}
            className="min-h-40 font-mono text-xs"
            spellCheck={false}
            value={text("html")}
            onChange={(e) => set({ html: e.target.value })}
          />
        </Field>
      ) : null}
    </section>
  );
}

function SocialSettings({
  links,
  onChange,
  align,
}: {
  links: SocialLink[];
  onChange: (links: SocialLink[]) => void;
  align: ReactNode;
}) {
  const update = (index: number, change: Partial<SocialLink>) =>
    onChange(links.map((link, i) => (i === index ? { ...link, ...change } : link)));
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {links.map((link, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id, and order is the identity.
          <li key={index} className="flex items-center gap-1.5">
            <NativeSelect
              aria-label={`Network ${index + 1}`}
              className="w-[118px] shrink-0"
              value={link.network}
              onChange={(e) => update(index, { network: e.target.value as SocialNetwork })}
            >
              {SOCIAL_NETWORKS.map((network) => (
                <option key={network} value={network}>
                  {NETWORK_LABELS[network]}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label={`Link ${index + 1}`}
              type="url"
              value={link.url}
              onChange={(e) => update(index, { url: e.target.value })}
            />
            <Button
              variant="destructive-ghost"
              size="icon-sm"
              onClick={() => onChange(links.filter((_, i) => i !== index))}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Remove link {index + 1}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={links.length >= 7}
        onClick={() => onChange([...links, { network: "website", url: "https://" }])}
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
        Add a link
      </Button>
      {align}
    </div>
  );
}
