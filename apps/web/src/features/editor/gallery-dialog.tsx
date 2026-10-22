import { applyBrand, type BrandSnapshot } from "@envelopen/email-render/brand";
import {
  GALLERY_CATEGORIES,
  GALLERY_TEMPLATES,
  type GalleryCategory,
  type GalleryTemplate,
} from "@envelopen/email-render/gallery";
import { renderMergeTags } from "@envelopen/email-render/merge-tags";
import { previewValues } from "@envelopen/email-render/personalize";
import { Link } from "@tanstack/react-router";
import { FilePlusIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLiveBrand } from "@/features/brand/shared";
import { cn } from "@/lib/utils";

// The template gallery (U15, R20). "New template" opens it. Each card shows a live
// preview of a starter template with the workspace's brand kit. Choosing a card opens
// the editor with that document (/templates/new?start=<id>). "Blank" opens the editor
// with the starter blocks, as before.

/** The width that the email renders at in a preview card, before it is scaled down. */
const EMAIL_FRAME_WIDTH = 640;
const EMAIL_FRAME_HEIGHT = 820;

/** The rendered HTML of each template, with its brand tokens. It renders once a session. */
const rendered = new Map<string, Promise<string>>();

function renderTemplate(template: GalleryTemplate): Promise<string> {
  let html = rendered.get(template.id);
  if (!html) {
    html = import("@envelopen/email-render/render").then(async ({ renderEmail }) => {
      const result = await renderEmail(template.document(), { preheader: template.preheader });
      return result.html;
    });
    // A failed render tries again next time.
    html.catch(() => rendered.delete(template.id));
    rendered.set(template.id, html);
  }
  return html;
}

/** Whether the brand kit has no name and no logo yet. */
export function isEmptyBrand(brand: BrandSnapshot): boolean {
  return brand.name.trim() === "" && !brand.logoUrl;
}

/** The brand for the previews: an empty brand kit shows a sample name. */
function previewBrand(brand: BrandSnapshot): BrandSnapshot {
  return brand.name.trim() ? brand : { ...brand, name: "Your brand" };
}

function usePreviewHtml(template: GalleryTemplate, brand: BrandSnapshot): string | null {
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    renderTemplate(template).then(
      (html) => live && setRaw(html),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [template]);
  if (raw === null) return null;
  const values = previewValues({ first_name: "Ada" }, window.location.origin);
  return renderMergeTags(applyBrand(raw, previewBrand(brand), "html"), values, "html");
}

/** A scaled-down, inert email preview. The scale follows the width of the card. */
function Thumbnail({ template, brand }: { template: GalleryTemplate; brand: BrandSnapshot }) {
  const html = usePreviewHtml(template, brand);
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const update = () => setScale(element.clientWidth / EMAIL_FRAME_WIDTH || 0.4);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      className="relative aspect-[4/5] overflow-hidden rounded-t-xl border-b border-border bg-[#f6f5f2]"
      aria-hidden="true"
    >
      {html === null ? (
        <div
          className="absolute inset-4 animate-pulse rounded-lg bg-card"
          data-testid="gallery-loading"
        />
      ) : (
        <iframe
          title={`${template.name} preview`}
          sandbox=""
          srcDoc={html}
          loading="lazy"
          tabIndex={-1}
          referrerPolicy="no-referrer"
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-[#f6f5f2]"
          style={{
            width: EMAIL_FRAME_WIDTH,
            height: EMAIL_FRAME_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      )}
    </div>
  );
}

/** A card with a stretched button: the whole card is one click and one tab stop. */
function Card({
  name,
  description,
  category,
  preview,
  onChoose,
}: {
  name: string;
  description: string;
  category: string;
  preview: ReactNode;
  onChoose: () => void;
}) {
  return (
    <li
      className="group relative flex flex-col rounded-xl border border-border bg-card transition-[border-color,box-shadow] duration-(--duration-press) hover:border-ring/50 hover:shadow-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
      data-testid="gallery-card"
    >
      {preview}
      <div className="flex flex-col gap-1 px-3.5 pt-3 pb-3.5">
        <h3 className="m-0 text-[13.5px] font-semibold tracking-[-0.01em]">
          <button
            type="button"
            onClick={onChoose}
            className="text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
          >
            {name}
          </button>
        </h3>
        <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">{description}</p>
        <p className="m-0 mt-1 text-[11.5px] text-muted-foreground">{category}</p>
      </div>
    </li>
  );
}

type Filter = "All" | GalleryCategory;
const FILTERS: Filter[] = ["All", ...GALLERY_CATEGORIES];

export function GalleryDialog({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chosen template, or null for a blank template. */
  onChoose: (template: GalleryTemplate | null) => void;
}) {
  const brand = useLiveBrand();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const words = query.trim().toLowerCase();
  const shown = GALLERY_TEMPLATES.filter(
    (template) =>
      (filter === "All" || template.category === filter) &&
      (!words ||
        `${template.name} ${template.description} ${template.category}`
          .toLowerCase()
          .includes(words)),
  );
  const showBlank = filter === "All" && (!words || "blank empty".includes(words));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-32px)] max-w-[1000px] gap-4 overflow-y-auto max-sm:p-4"
        data-testid="template-gallery"
      >
        <DialogHeader
          title="Start a template"
          description="Choose a design. Each one uses your brand kit: the logo, colors, font, and footer."
        />
        {isEmptyBrand(brand) ? (
          <p
            className="m-0 rounded-lg bg-tone-neutral px-3 py-2 text-[12.5px] text-tone-neutral-foreground"
            data-testid="gallery-brand-hint"
          >
            Your brand kit is empty, so the previews use the default colors.{" "}
            <Link to="/brand" className="font-medium underline underline-offset-2">
              Set up your brand kit
            </Link>{" "}
            to see your logo and colors here.
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:w-[240px]">
            <label htmlFor={searchId} className="sr-only">
              Search templates
            </label>
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder="Search templates"
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
            <legend className="sr-only">Category</legend>
            {FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
                className={cn(
                  "inline-flex min-h-[30px] items-center rounded-full border px-3 text-[12.5px] transition-colors max-sm:min-h-10",
                  filter === item
                    ? "border-transparent bg-primary font-medium text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {item}
              </button>
            ))}
          </fieldset>
        </div>
        {shown.length === 0 && !showBlank ? (
          <p className="m-0 py-8 text-center text-[13px] text-muted-foreground" role="status">
            No template matches “{query.trim()}”. Clear the search or choose another category.
          </p>
        ) : (
          <ul
            className="m-0 grid list-none grid-cols-1 gap-4 p-0 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
            aria-label="Templates"
          >
            {showBlank ? (
              <Card
                name="Blank"
                description="Start with a heading, a paragraph, and the footer."
                category="Any"
                onChoose={() => onChoose(null)}
                preview={
                  <div
                    className="flex aspect-[4/5] items-center justify-center rounded-t-xl border-b border-dashed max-[419px]:aspect-auto max-[419px]:h-24 border-border bg-muted text-muted-foreground"
                    aria-hidden="true"
                  >
                    <FilePlusIcon className="size-7" strokeWidth={1.5} />
                  </div>
                }
              />
            ) : null}
            {shown.map((template) => (
              <Card
                key={template.id}
                name={template.name}
                description={template.description}
                category={template.category}
                onChoose={() => onChoose(template)}
                preview={open ? <Thumbnail template={template} brand={brand} /> : null}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
