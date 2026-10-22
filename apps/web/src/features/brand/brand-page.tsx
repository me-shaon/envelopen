import {
  BRAND_COLOR_TOKENS,
  type EmailDocument,
  SOCIAL_NETWORKS,
  type SocialNetwork,
} from "@envelopen/email-render/blocks/types";
import { applyBrand, type BrandSnapshot, normalizeHexColor } from "@envelopen/email-render/brand";
import { renderMergeTags } from "@envelopen/email-render/merge-tags";
import { previewValues } from "@envelopen/email-render/personalize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUpIcon, Trash2Icon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api, unwrap } from "@/api/client";
import { brandQuery } from "@/api/queries";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { UnsavedChangesGuard } from "@/components/unsaved-changes";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { EmailPreview } from "@/features/editor/preview";
import { type Brand, NETWORK_LABELS, snapshotOfBrand } from "./shared";

// The brand page (U13, R18). The fields are on the left. On the right, a sample email
// renders with the same renderer as the template editor and the brand of the fields, so
// each change shows at once. Templates use the brand through the brand header and footer
// blocks, the brand colors of a button, and the brand font.

const LOGO_TYPES = "image/png,image/jpeg,image/gif,image/webp";
const LOGO_MAX_BYTES = 1024 * 1024;

interface Draft {
  name: string;
  colorPrimary: string;
  colorAccent: string;
  font: Brand["font"];
  footer: string;
  address: string;
  social: Record<SocialNetwork, string>;
}

function draftOf(brand: Brand): Draft {
  const social = Object.fromEntries(
    SOCIAL_NETWORKS.map((network) => [network, brand.social[network] ?? ""]),
  ) as Record<SocialNetwork, string>;
  return {
    name: brand.name,
    colorPrimary: brand.colorPrimary,
    colorAccent: brand.colorAccent,
    font: brand.font,
    footer: brand.footer,
    address: brand.address,
    social,
  };
}

function bodyOf(draft: Draft) {
  return {
    name: draft.name.trim(),
    colorPrimary: draft.colorPrimary.trim(),
    colorAccent: draft.colorAccent.trim(),
    font: draft.font,
    footer: draft.footer.trim(),
    address: draft.address.trim(),
    social: Object.fromEntries(
      Object.entries(draft.social).map(([network, url]) => [network, url.trim()]),
    ),
  };
}

/** The sample email of the preview: every brand block, a brand button, and the brand font. */
function sampleDocument(networks: SocialNetwork[]): EmailDocument {
  return {
    type: "doc",
    attrs: { font: "brand" },
    content: [
      { type: "brandHeader", attrs: { align: "center", showName: true, logoWidth: 160 } },
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Your monthly update" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "mergeTag", attrs: { field: "first_name", fallback: "there" } },
          {
            type: "text",
            text: ". This sample email shows your brand. Templates with the brand header, the brand footer, a brand color, or the brand font look the same.",
          },
        ],
      },
      {
        type: "button",
        attrs: {
          label: "Read more",
          href: "https://example.com",
          align: "left",
          background: BRAND_COLOR_TOKENS.primary,
          color: BRAND_COLOR_TOKENS.onPrimary,
        },
      },
      { type: "brandFooter", attrs: { align: "center", networks } },
    ],
  };
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function ColorField({
  id,
  label,
  hint,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const hex = normalizeHexColor(value);
  return (
    <Field id={id} label={label} hint={hint} error={error ?? (hex ? null : "Use a hex color.")}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={hex ?? "#000000"}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-[9px] border border-input bg-card p-1"
        />
        <Input
          id={id}
          value={value}
          maxLength={7}
          spellCheck={false}
          className="font-mono text-[13px]"
          aria-describedby={`${id}-hint`}
          aria-invalid={hex ? undefined : true}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </Field>
  );
}

function BrandPreview({ brand }: { brand: BrandSnapshot }) {
  const networks = useMemo(
    () => SOCIAL_NETWORKS.filter((network) => brand.social[network]),
    [brand.social],
  );
  const key = networks.join(",");
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import("@envelopen/email-render/render").then(async ({ renderEmail }) => {
      const { html } = await renderEmail(
        sampleDocument(key ? (key.split(",") as SocialNetwork[]) : []),
        {
          preheader: "A sample email with your brand",
        },
      );
      if (live) setRaw(html);
    });
    return () => {
      live = false;
    };
  }, [key]);
  const values = useMemo(
    () => previewValues({ first_name: "Ada", last_name: "Lovelace" }, window.location.origin),
    [],
  );
  const html =
    raw === null ? null : renderMergeTags(applyBrand(raw, brand, "html"), values, "html");
  return (
    <section aria-labelledby="brand-preview-title" className="flex min-w-0 flex-col gap-3">
      <SectionHeader id="brand-preview-title" title="Preview" aside="A sample email" />
      <EmailPreview
        html={html}
        subject={`News from ${brand.name || "your brand"}`}
        preheader="A sample email with your brand"
        missing={[]}
      />
    </section>
  );
}

function LogoField({ brand }: { brand: Brand }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const done = (result: Brand, message: string) => {
    queryClient.setQueryData(brandQuery(current.id).queryKey, result);
    toast(message);
  };
  const upload = useMutation({
    mutationFn: async (file: File) =>
      unwrap(
        api.POST("/brand/logo", {
          body: { filename: file.name, contentType: file.type, content: await base64Of(file) },
        }),
      ),
    onSuccess: (result) => done(result, "Logo saved."),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/brand/logo")),
    onSuccess: (result) => done(result, "Logo removed."),
  });

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setLocalError(null);
    upload.reset();
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      setLocalError("The logo is larger than 1 MB. Use a smaller file.");
      return;
    }
    upload.mutate(file);
  }

  const error = localError ?? errorText(upload.error) ?? errorText(remove.error);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium" id="brand-logo-label">
        Logo
      </span>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border p-3">
        <div className="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {brand.logo ? (
            <img
              src={brand.logo.url}
              alt="Current logo"
              data-testid="brand-logo"
              className="max-h-14 max-w-28 object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">No logo</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              id="brand-logo"
              type="file"
              accept={LOGO_TYPES}
              className="sr-only"
              aria-labelledby="brand-logo-label"
              aria-describedby="brand-logo-hint"
              onChange={onFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              pending={upload.isPending}
              onClick={() => input.current?.click()}
            >
              <ImageUpIcon className="size-3.5" aria-hidden="true" />
              {brand.logo ? "Replace logo" : "Upload logo"}
            </Button>
            {brand.logo ? (
              <Button
                type="button"
                variant="destructive-ghost"
                size="sm"
                pending={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <Trash2Icon className="size-3.5" aria-hidden="true" />
                Remove
              </Button>
            ) : null}
          </div>
          <p id="brand-logo-hint" className="m-0 text-xs text-muted-foreground">
            PNG, JPEG, GIF, or WebP, at most 1 MB. SVG is not accepted.
            {brand.logo?.width && brand.logo.height
              ? ` The current logo is ${brand.logo.width} × ${brand.logo.height} px.`
              : ""}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs text-tone-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BrandForm({ brand }: { brand: Brand }) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(brand));
  const [saved, setSaved] = useState<Draft>(() => draftOf(brand));
  const update = (change: Partial<Draft>) => setDraft((value) => ({ ...value, ...change }));
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/brand", { body: bodyOf(draft) })),
    onSuccess: (result) => {
      setSaved(draft);
      queryClient.setQueryData(brandQuery(current.id).queryKey, result);
      toast("Brand saved. Drafts and previews use it now.");
    },
  });
  const fieldError =
    save.error instanceof ApiRequestError
      ? ((save.error.details as { field?: string } | undefined)?.field ?? null)
      : null;
  const errorOf = (name: string) => (fieldError === name ? errorText(save.error) : null);

  // The preview shows the fields as they are now, before the save.
  const live: BrandSnapshot = {
    ...snapshotOfBrand(brand),
    name: draft.name.trim() || current.name,
    colorPrimary: normalizeHexColor(draft.colorPrimary) ?? brand.colorPrimary,
    colorAccent: normalizeHexColor(draft.colorAccent) ?? brand.colorAccent,
    font: draft.font,
    footer: draft.footer,
    address: draft.address,
    social: Object.fromEntries(
      Object.entries(draft.social).filter(([, url]) => /^https:\/\/\S+$/.test(url.trim())),
    ),
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,680px)]">
      <UnsavedChangesGuard when={changed && !save.isPending} what="the brand" />
      <form className="flex min-w-0 flex-col gap-6" onSubmit={onSubmit} aria-label="Brand kit">
        <FormError message={fieldError ? null : errorText(save.error)} />
        <Field
          id="brand-name"
          label="Brand name"
          hint={`The brand header shows it. Empty uses the workspace name, ${current.name}.`}
          error={errorOf("name")}
        >
          <Input
            id="brand-name"
            maxLength={100}
            value={draft.name}
            placeholder={current.name}
            aria-describedby="brand-name-hint"
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <LogoField brand={brand} />
        <div className="grid gap-4 sm:grid-cols-2">
          <ColorField
            id="brand-color-primary"
            label="Primary color"
            hint="Buttons, links, and the brand name."
            value={draft.colorPrimary}
            error={errorOf("colorPrimary")}
            onChange={(colorPrimary) => update({ colorPrimary })}
          />
          <ColorField
            id="brand-color-accent"
            label="Accent color"
            hint="A second color for buttons and highlights."
            value={draft.colorAccent}
            error={errorOf("colorAccent")}
            onChange={(colorAccent) => update({ colorAccent })}
          />
        </div>
        <Field
          id="brand-font"
          label="Font"
          hint="Web-safe fonts only, so every mail app shows them."
        >
          <NativeSelect
            id="brand-font"
            value={draft.font}
            aria-describedby="brand-font-hint"
            onChange={(event) => update({ font: event.target.value as Brand["font"] })}
          >
            {brand.fonts.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id="brand-footer"
          label="Footer text"
          hint="The brand footer block shows it, for example why people get your emails."
          error={errorOf("footer")}
        >
          <Textarea
            id="brand-footer"
            maxLength={500}
            className="min-h-16"
            value={draft.footer}
            aria-describedby="brand-footer-hint"
            onChange={(event) => update({ footer: event.target.value })}
          />
        </Field>
        <Field
          id="brand-address"
          label="Postal address"
          hint="Required before you can send a campaign. Many anti-spam laws ask for it in each email. The brand footer block shows it."
          error={errorOf("address")}
        >
          <Textarea
            id="brand-address"
            maxLength={300}
            className="min-h-16"
            value={draft.address}
            aria-describedby="brand-address-hint"
            onChange={(event) => update({ address: event.target.value })}
          />
        </Field>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[13px] font-medium">Social links</legend>
          <p className="m-0 -mt-1 text-xs text-muted-foreground">
            Full https addresses. The brand footer block links to each one that you add.
          </p>
          {SOCIAL_NETWORKS.map((network) => (
            <Field
              key={network}
              id={`brand-social-${network}`}
              label={NETWORK_LABELS[network]}
              error={errorOf(`social.${network}`)}
            >
              <Input
                id={`brand-social-${network}`}
                type="url"
                inputMode="url"
                maxLength={500}
                placeholder="https://"
                value={draft.social[network]}
                onChange={(event) =>
                  update({ social: { ...draft.social, [network]: event.target.value } })
                }
              />
            </Field>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" pending={save.isPending}>
            Save brand
          </Button>
        </div>
      </form>
      <div className="lg:sticky lg:top-6 lg:self-start">
        <BrandPreview brand={live} />
      </div>
    </div>
  );
}

export function BrandPage() {
  const { current } = useCurrentWorkspace();
  const brand = useQuery(brandQuery(current.id));
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Brand"
        description="Your name, logo, colors, font, footer, and postal address. Templates and drafts use them at once. A confirmed campaign keeps the brand of its confirm time."
      />
      {brand.data ? (
        <BrandForm key={current.id} brand={brand.data} />
      ) : brand.isError ? (
        <FormError message={errorText(brand.error) ?? "The brand did not load."} />
      ) : (
        <LoadingRegion label="Loading the brand" className="flex flex-col gap-4">
          <Skeleton className="h-[60px] max-w-xl rounded-[9px]" />
          <Skeleton className="h-[92px] max-w-xl rounded-xl" />
          <Skeleton className="h-[60px] max-w-xl rounded-[9px]" />
        </LoadingRegion>
      )}
    </div>
  );
}
