import {
  BRAND_COLOR_TOKENS,
  PANEL_PADDINGS,
  PANEL_TINT,
  SOCIAL_NETWORKS,
  type SocialLink,
  type SocialNetwork,
} from "@envelopen/email-render/blocks/types";
import { brandTokenValue } from "@envelopen/email-render/brand";
import { Link } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useBrand } from "@/features/brand/shared";
import { cn } from "@/lib/utils";
import { type SelectedPanel, setPanelAttrs, setSectionColumns } from "./doc";
import { useColor } from "./extensions";
import { Segmented } from "./preview";

// Settings of the selected atom block and of the section around the selection (U14).
// Each change is an editor transaction, so undo and redo work as for text.

const TITLES: Record<string, string> = {
  image: "Image",
  button: "Button",
  divider: "Divider",
  spacer: "Spacer",
  social: "Social links",
  footer: "Footer",
  html: "Raw HTML",
  mergeTag: "Merge tag",
  brandHeader: "Brand header",
  brandFooter: "Brand footer",
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
          <ColorSetting
            id={id("background")}
            label="Background"
            value={attrs.background}
            fallback="#1a1917"
            onChange={(background) => set({ background })}
          />
          <ColorSetting
            id={id("color")}
            label="Text"
            value={attrs.color}
            fallback="#ffffff"
            text
            onChange={(color) => set({ color })}
          />
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

      {type === "brandHeader" ? (
        <>
          <BrandNote />
          <div className="flex items-center gap-2.5">
            <Checkbox
              id={id("showName")}
              checked={attrs.showName !== false}
              onCheckedChange={(checked) => set({ showName: checked === true })}
            />
            <Label htmlFor={id("showName")} className="cursor-pointer font-normal">
              Show the brand name
            </Label>
          </div>
          <Field id={id("logoWidth")} label="Logo width in pixels">
            <Input
              id={id("logoWidth")}
              type="number"
              min={40}
              max={600}
              value={Number(attrs.logoWidth) || 160}
              onChange={(e) => set({ logoWidth: Number(e.target.value) })}
            />
          </Field>
          <AlignSelect id={id("align")} value={attrs.align} onChange={(align) => set({ align })} />
        </>
      ) : null}

      {type === "brandFooter" ? (
        <BrandFooterSettings
          networks={Array.isArray(attrs.networks) ? (attrs.networks as SocialNetwork[]) : []}
          onChange={(networks) => set({ networks })}
          align={
            <AlignSelect
              id={id("align")}
              value={attrs.align}
              onChange={(align) => set({ align })}
            />
          }
        />
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

/** Where the brand values come from, with a link to change them. */
function BrandNote() {
  return (
    <p className="m-0 text-[13px] text-muted-foreground">
      The logo, name, colors, and font come from the{" "}
      <Link to="/brand" className="text-foreground underline underline-offset-2">
        brand kit
      </Link>
      . A change there reaches every draft.
    </p>
  );
}

/**
 * A color setting: a brand color token or a custom hex color. A brand color follows the
 * brand kit, and a confirmed campaign keeps the color of its confirm time.
 */
function ColorSetting({
  id,
  label,
  value,
  fallback,
  onChange,
  text = false,
  tint = false,
}: {
  id: string;
  label: string;
  value: unknown;
  fallback: string;
  onChange: (value: string) => void;
  /** A text color: it also offers the readable text colors for the brand colors (U15). */
  text?: boolean;
  /** A panel background: it also offers the light tint (U15). */
  tint?: boolean;
}) {
  const shown = useColor(value, fallback);
  const brand = useBrand();
  const choices = [
    { token: BRAND_COLOR_TOKENS.primary, name: "Brand primary", color: brand.colorPrimary },
    { token: BRAND_COLOR_TOKENS.accent, name: "Brand accent", color: brand.colorAccent },
    ...(text
      ? [
          {
            token: BRAND_COLOR_TOKENS.onPrimary,
            name: "Readable on primary",
            color: brandTokenValue(brand, "brand.color_on_primary"),
          },
          {
            token: BRAND_COLOR_TOKENS.onAccent,
            name: "Readable on accent",
            color: brandTokenValue(brand, "brand.color_on_accent"),
          },
        ]
      : []),
    ...(tint ? [{ token: PANEL_TINT, name: "Light tint", color: PANEL_TINT }] : []),
  ];
  const custom = !choices.some((choice) => choice.token === value);
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map((choice) => (
          <button
            key={choice.token}
            type="button"
            aria-pressed={value === choice.token}
            onClick={() => onChange(choice.token)}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2 text-[12px] transition-colors",
              value === choice.token
                ? "border-ring bg-accent font-medium"
                : "border-border hover:bg-accent",
            )}
          >
            <span
              className="size-3.5 rounded-full border border-black/10"
              style={{ background: choice.color }}
              aria-hidden="true"
            />
            {choice.name}
          </button>
        ))}
        <label
          htmlFor={id}
          className={cn(
            "inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-[12px]",
            custom ? "border-ring bg-accent font-medium" : "border-border hover:bg-accent",
          )}
        >
          <input
            id={id}
            type="color"
            value={custom ? shown : fallback}
            onChange={(e) => onChange(e.target.value)}
            className="size-4 cursor-pointer border-0 bg-transparent p-0"
          />
          Custom
        </label>
      </div>
    </fieldset>
  );
}

function BrandFooterSettings({
  networks,
  onChange,
  align,
}: {
  networks: SocialNetwork[];
  onChange: (networks: SocialNetwork[]) => void;
  align: ReactNode;
}) {
  const brand = useBrand();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-muted-foreground">
        The footer text, the postal address, and the social links come from the{" "}
        <Link to="/brand" className="text-foreground underline underline-offset-2">
          brand kit
        </Link>
        . The unsubscribe and preference links are always added.
      </p>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[13px] font-medium">Social links to show</legend>
        {SOCIAL_NETWORKS.map((network) => {
          const checkboxId = `brand-footer-network-${network}`;
          const missing = !brand.social[network];
          return (
            <div key={network} className="flex items-center gap-2.5">
              <Checkbox
                id={checkboxId}
                checked={networks.includes(network)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? SOCIAL_NETWORKS.filter((n) => n === network || networks.includes(n))
                      : networks.filter((n) => n !== network),
                  )
                }
              />
              <Label htmlFor={checkboxId} className="cursor-pointer font-normal">
                {NETWORK_LABELS[network]}
                {missing ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">No link in the kit</span>
                ) : null}
              </Label>
            </div>
          );
        })}
        <p className="m-0 text-xs text-muted-foreground">
          A network without a link in the brand kit is left out of the email.
        </p>
      </fieldset>
      {align}
    </div>
  );
}

const COLUMN_CHOICES = [
  { id: "1", label: "1", name: "1 column" },
  { id: "2", label: "2", name: "2 columns" },
  { id: "3", label: "3", name: "3 columns" },
] as const;

/**
 * Settings of a section: the number of columns (1 to 3, R22). Fewer columns move the
 * content of each removed column into the last column that stays.
 */
export function SectionSettings({
  editor,
  section,
}: {
  editor: Editor;
  section: { pos: number; count: number };
}) {
  const remove = () => {
    const node = editor.state.doc.nodeAt(section.pos);
    if (!node) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: section.pos, to: section.pos + node.nodeSize })
      .run();
  };
  return (
    <section
      aria-labelledby="section-settings-title"
      className="flex flex-col gap-4 rounded-xl border border-border p-4"
      data-testid="section-settings"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="section-settings-title"
          className="m-0 text-[14px] font-semibold tracking-[-0.01em]"
        >
          Section
        </h2>
        <Button variant="destructive-ghost" size="icon-sm" onClick={remove}>
          <Trash2Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Delete the section</span>
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-[13px] font-medium" aria-hidden="true">
          Columns
        </p>
        <Segmented
          label="Columns"
          value={String(section.count) as "1" | "2" | "3"}
          options={[...COLUMN_CHOICES]}
          onChange={(count) => setSectionColumns(editor, section.pos, Number(count))}
        />
        <p className="m-0 text-xs text-muted-foreground">
          With fewer columns, the content of a removed column moves into the last column. On a
          phone, the columns show one below the other.
        </p>
      </div>
    </section>
  );
}

const PADDING_CHOICES = [
  { id: "20", label: "Small" },
  { id: "28", label: "Medium" },
  { id: "40", label: "Large" },
] as const;

/** The settings of the selected panel (U15): background, padding, and alignment. */
export function PanelSettings({ editor, panel }: { editor: Editor; panel: SelectedPanel }) {
  const set = (attrs: Record<string, unknown>) => setPanelAttrs(editor, panel.pos, attrs);
  const remove = () => {
    const node = editor.state.doc.nodeAt(panel.pos);
    if (!node) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: panel.pos, to: panel.pos + node.nodeSize })
      .run();
  };
  const padding = (PANEL_PADDINGS as readonly number[]).includes(Number(panel.attrs.padding))
    ? String(panel.attrs.padding)
    : "28";
  return (
    <section
      aria-labelledby="panel-settings-title"
      className="flex flex-col gap-4 rounded-xl border border-border p-4"
      data-testid="panel-settings"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="panel-settings-title" className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
          Panel
        </h2>
        <Button variant="destructive-ghost" size="icon-sm" onClick={remove}>
          <Trash2Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Delete the panel</span>
        </Button>
      </div>
      <ColorSetting
        id={`panel-${panel.pos}-background`}
        label="Background"
        value={panel.attrs.background}
        fallback={PANEL_TINT}
        tint
        onChange={(background) => set({ background })}
      />
      <p className="m-0 text-xs text-muted-foreground">
        The text color follows the background, so the text stays easy to read.
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-[13px] font-medium" aria-hidden="true">
          Padding
        </p>
        <Segmented
          label="Padding"
          value={padding as "20" | "28" | "40"}
          options={[...PADDING_CHOICES]}
          onChange={(value) => set({ padding: Number(value) })}
        />
      </div>
      <AlignSelect
        id={`panel-${panel.pos}-align`}
        value={panel.attrs.align}
        onChange={(align) => set({ align })}
      />
    </section>
  );
}
