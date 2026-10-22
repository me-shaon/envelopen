import {
  type BlockNode,
  type EmailDocument,
  starterDocument,
} from "@envelopen/email-render/blocks/types";
import {
  applyBrand,
  BRAND_FONTS,
  type BrandSnapshot,
  brandFontStack,
  isBrandFont,
} from "@envelopen/email-render/brand";
import { type GalleryTemplate, galleryTemplate } from "@envelopen/email-render/gallery";
import { missingMergeTags, renderMergeTags } from "@envelopen/email-render/merge-tags";
import { previewValues } from "@envelopen/email-render/personalize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BoldIcon,
  BracesIcon,
  EyeIcon,
  ItalicIcon,
  LinkIcon,
  type LucideIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  Redo2Icon,
  SendIcon,
  SmartphoneIcon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { mergeFieldsQuery, templateQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { UnsavedChangesGuard } from "@/components/unsaved-changes";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { BrandContext, useLiveBrand } from "@/features/brand/shared";
import { errorText } from "@/features/contacts/shared";
import { cn } from "@/lib/utils";
import { BlockLibrary, type LibraryEntry, LibrarySheet } from "./block-library";
import { BlockSettings, PanelSettings, SectionSettings } from "./block-settings";
import {
  blockName,
  blockPlace,
  boundaryAt,
  currentBlock,
  documentFont,
  documentOf,
  insertBlocks,
  LIBRARY_MIME,
  selectedAtom,
  selectedPanel,
  selectedSection,
  setDocumentFont,
} from "./doc";
import { BlockDragHandle } from "./drag-handle";
import { editorExtensions } from "./extensions";
import { EmailPreview, type PreviewMode, Segmented } from "./preview";
import { SendTestDialog } from "./send-test-dialog";
import { FormatPill } from "./templates-page";

// The template editor (R26 to R30). Blocks are Tiptap v3 nodes. On save, the browser
// renders the document with React Email (KTD26) and sends the editor JSON, the HTML,
// and the text part. The Worker sanitizes the HTML (KTD27). The preview renders the
// same HTML with sample merge values in a sandboxed iframe.
//
// This module is a lazy route: Tiptap and React Email load only when the editor opens.

type Template = Schemas["Template"];
type MergeField = Schemas["MergeFieldList"]["items"][number];

/** The renderer is large (React Email and react-dom/server), so it loads on first use. */
function loadRenderer() {
  return import("@envelopen/email-render/render");
}

/** Sample merge values: the standard fields have samples, custom fields stay empty. */
function sampleValues(fields: MergeField[] | undefined) {
  const values: Record<string, string | null> = {};
  for (const field of fields ?? []) {
    if (field.kind === "standard" || field.kind === "custom") values[field.key] = field.sample;
  }
  return previewValues(values, window.location.origin);
}

interface Draft {
  name: string;
  subject: string;
  preheader: string;
}

/**
 * The route component: /templates/new starts a template, /templates/new?start=<id> starts
 * from a gallery template (U15), and /templates/<id> opens one.
 */
export function EditorRoute() {
  const { templateId } = useParams({ strict: false }) as { templateId?: string };
  const { start } = useSearch({ strict: false }) as { start?: string };
  const id = Number(templateId);
  const existing = Number.isSafeInteger(id) && id > 0 ? id : null;
  const starter = existing === null ? galleryTemplate(start) : null;
  return (
    <EditorPage
      // A new key per template, so the editor starts fresh when the id changes.
      key={`${templateId ?? "new"}:${starter?.id ?? ""}`}
      templateId={existing}
      starter={starter}
    />
  );
}

/** Loads the template, or starts a new one, then shows the editor for its format. */
export function EditorPage({
  templateId,
  starter = null,
}: {
  templateId: number | null;
  /** The gallery template that a new template starts from. Null: the starter blocks. */
  starter?: GalleryTemplate | null;
}) {
  const { current } = useCurrentWorkspace();
  const template = useQuery({
    ...templateQuery(current.id, templateId ?? 0),
    enabled: templateId !== null,
  });
  if (templateId !== null && template.isPending) {
    return <EditorSkeleton />;
  }
  if (templateId !== null && !template.data) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <FormError message={errorText(template.error) ?? "The template did not load."} />
      </div>
    );
  }
  const data = template.data ?? null;
  if (data && data.format !== "blocks") return <SourceEditor template={data} />;
  return <BlockEditor template={data} starter={starter} />;
}

/** The editor while the template loads: the header, the subject fields, and the canvas. */
function EditorSkeleton() {
  return (
    <LoadingRegion label="Loading the template" className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[34px] w-[280px] max-w-full" />
            <Skeleton className="h-3 w-24 rounded-sm" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-[104px] rounded-[9px]" />
            <Skeleton className="h-9 w-16 rounded-[9px]" />
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-[60px] rounded-[9px]" />
        <Skeleton className="h-[60px] rounded-[9px]" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_288px]">
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-muted">
          <div className="h-11 border-b border-border" />
          <div className="px-3 py-6 sm:px-6">
            <div className="mx-auto flex max-w-[600px] flex-col gap-3 rounded-xl border border-border bg-card px-6 py-8 sm:px-10">
              <Skeleton className="h-6 w-[55%]" />
              <Skeleton className="h-3.5 w-[90%] rounded-sm" />
              <Skeleton className="h-3.5 w-[82%] rounded-sm" />
              <Skeleton className="h-3.5 w-[64%] rounded-sm" />
              <Skeleton className="mt-3 h-9 w-32 rounded-[9px]" />
            </div>
          </div>
        </div>
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    </LoadingRegion>
  );
}

function BackLink() {
  return (
    <Link
      to="/templates"
      className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Templates
    </Link>
  );
}

/** Saves a template: creates it the first time, then updates it. Returns the saved row. */
function useSaveTemplate(templateId: number | null) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      subject: string | null;
      preheader: string | null;
      format: Template["format"];
      source: string;
      html?: string;
      text?: string;
    }): Promise<Template> =>
      templateId === null
        ? unwrap(api.POST("/templates", { body }))
        : unwrap(api.PATCH("/templates/{id}", { params: { path: { id: templateId } }, body })),
    onSuccess: async (saved) => {
      queryClient.setQueryData(templateQuery(current.id, saved.id).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "templates", "list"] });
      if (templateId === null) {
        await navigate({
          to: "/templates/$templateId",
          params: { templateId: String(saved.id) },
          replace: true,
          // The template is saved, so the move to its address does not ask first.
          ignoreBlocker: true,
        });
      }
    },
  });
}

function EditorHeader({
  draft,
  onDraft,
  status,
  format,
  actions,
}: {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  status: string;
  format: Template["format"];
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <label htmlFor="template-name" className="sr-only">
            Template name
          </label>
          <input
            id="template-name"
            value={draft.name}
            maxLength={100}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
            // The negative margin lines the text up with the back link above it.
            className="-ml-[5px] min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[30px] leading-[1.15] font-semibold tracking-[-0.035em] hover:border-border focus:border-input"
          />
          <FormatPill format={format} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" role="status" data-testid="save-status">
            {status}
          </span>
          {actions}
        </div>
      </div>
    </div>
  );
}

function MergeTagMenu({
  fields,
  label,
  onPick,
}: {
  fields: MergeField[];
  label: string;
  onPick: (field: MergeField) => void;
}) {
  const groups = [
    {
      title: "Contact fields",
      items: fields.filter((f) => f.kind === "standard" || f.kind === "custom"),
    },
    { title: "Brand", items: fields.filter((f) => f.kind === "brand") },
    { title: "Links", items: fields.filter((f) => f.kind === "reserved") },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" type="button">
          <BracesIcon className="size-3.5" aria-hidden="true" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {groups.map((group) =>
          group.items.length === 0 ? null : (
            <div key={group.title}>
              <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
              {group.items.map((field) => (
                <DropdownMenuItem key={field.key} onSelect={() => onPick(field)}>
                  <span className="flex-1">{field.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{field.key}</span>
                </DropdownMenuItem>
              ))}
            </div>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SubjectFields({
  draft,
  onDraft,
  fields,
}: {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  fields: MergeField[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="template-subject" className="text-[13px] font-medium">
            Subject
          </label>
          <MergeTagMenu
            label="Merge tag"
            fields={fields.filter((f) => f.kind !== "reserved")}
            onPick={(field) => onDraft({ ...draft, subject: `${draft.subject}{{ ${field.key} }}` })}
          />
        </div>
        <Input
          id="template-subject"
          value={draft.subject}
          maxLength={200}
          placeholder="What is this email about?"
          onChange={(event) => onDraft({ ...draft, subject: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-h-[30px] items-center">
          <label htmlFor="template-preheader" className="text-[13px] font-medium">
            Preheader
          </label>
        </div>
        <Input
          id="template-preheader"
          value={draft.preheader}
          maxLength={200}
          placeholder="Optional"
          aria-describedby="template-preheader-hint"
          onChange={(event) => onDraft({ ...draft, preheader: event.target.value })}
        />
        <p id="template-preheader-hint" className="m-0 text-xs text-muted-foreground">
          The short line that inboxes show after the subject.
        </p>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  active,
  disabled,
  shortcut,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  /** The keyboard shortcut, as `aria-keyshortcuts` writes it. */
  shortcut?: { aria: string; shown: string };
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut?.aria}
      title={shortcut ? `${label} (${shortcut.shown})` : label}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-accent")}
    >
      <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
    </Button>
  );
}

function Toolbar({
  editor,
  fields,
  onLink,
  onLibrary,
}: {
  editor: Editor;
  fields: MergeField[];
  onLink: () => void;
  /** Opens the block library sheet on narrow screens. */
  onLibrary: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      place: blockPlace(e),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      link: e.isActive("link"),
      style: e.isActive("heading", { level: 1 })
        ? "h1"
        : e.isActive("heading", { level: 2 })
          ? "h2"
          : e.isActive("heading", { level: 3 })
            ? "h3"
            : e.isActive("paragraph")
              ? "p"
              : "",
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  function setStyle(value: string) {
    const chain = editor.chain().focus();
    if (value === "p") chain.setParagraph().run();
    else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
  }
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-hairline bg-card px-2 py-1.5"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="@min-[700px]/builder:hidden"
        onClick={onLibrary}
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
        Add block
      </Button>
      <NativeSelect
        aria-label="Text style"
        className="w-[128px]"
        value={state.style}
        disabled={state.style === ""}
        onChange={(event) => setStyle(event.target.value)}
      >
        <option value="" disabled hidden>
          Text style
        </option>
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </NativeSelect>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <ToolbarButton
        label="Bold"
        icon={BoldIcon}
        active={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="Italic"
        icon={ItalicIcon}
        active={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="Underline"
        icon={UnderlineIcon}
        active={state.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <ToolbarButton label="Link" icon={LinkIcon} active={state.link} onClick={onLink} />
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <MergeTagMenu
        label="Merge tag"
        fields={fields.filter((f) => f.kind !== "reserved")}
        onPick={(field) =>
          editor
            .chain()
            .focus()
            .insertContent({
              type: "mergeTag",
              attrs: { field: field.key, fallback: field.key === "first_name" ? "there" : "" },
            })
            .run()
        }
      />
      <span className="ml-auto flex items-center gap-1">
        <ToolbarButton
          label="Move up"
          icon={ArrowUpIcon}
          disabled={state.place.index <= 0}
          shortcut={{ aria: "Alt+Shift+ArrowUp", shown: "Alt+Shift+Up" }}
          onClick={() => editor.chain().focus().moveBlock("up").run()}
        />
        <ToolbarButton
          label="Move down"
          icon={ArrowDownIcon}
          disabled={state.place.index >= state.place.count - 1}
          shortcut={{ aria: "Alt+Shift+ArrowDown", shown: "Alt+Shift+Down" }}
          onClick={() => editor.chain().focus().moveBlock("down").run()}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <ToolbarButton
          label="Undo"
          icon={Undo2Icon}
          disabled={!state.canUndo}
          onClick={() => editor.chain().focus().undo().run()}
        />
        <ToolbarButton
          label="Redo"
          icon={Redo2Icon}
          disabled={!state.canRedo}
          onClick={() => editor.chain().focus().redo().run()}
        />
      </span>
    </div>
  );
}

function LinkDialog({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const current = (editor.getAttributes("link").href as string | undefined) ?? "";
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const href = String(new FormData(event.currentTarget).get("href") ?? "").trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href) chain.setLink({ href }).run();
    else chain.unsetLink().run();
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="Link"
          description="Select text first. Leave the field empty to remove the link."
        />
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <Field id="link-href" label="URL">
            <Input
              id="link-href"
              name="href"
              type="url"
              defaultValue={current}
              placeholder="https://"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The email's font: the default font or the brand font of the brand kit (U13). */
function FontSetting({ editor, brand }: { editor: Editor; brand: BrandSnapshot }) {
  const font = useEditorState({ editor, selector: ({ editor: e }) => documentFont(e) });
  return (
    <Field
      id="email-font"
      label="Email font"
      hint="The brand font follows the brand kit. A confirmed campaign keeps the font of its confirm time."
    >
      <NativeSelect
        id="email-font"
        value={font ?? "default"}
        aria-describedby="email-font-hint"
        onChange={(event) =>
          setDocumentFont(editor, event.target.value === "brand" ? "brand" : null)
        }
      >
        <option value="default">Default sans-serif</option>
        <option value="brand">
          Brand font ({isBrandFont(brand.font) ? BRAND_FONTS[brand.font].label : "System"})
        </option>
      </NativeSelect>
    </Field>
  );
}

function SaveBlockDialog({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (name: string) => {
      const block = currentBlock(editor);
      if (!block) throw new Error("Select a block first.");
      const nodes = [block.node] as BlockNode[];
      const { renderBlocks } = await loadRenderer();
      return unwrap(
        api.POST("/saved-blocks", {
          body: { name, content: JSON.stringify(nodes), html: await renderBlocks(nodes) },
        }),
      );
    },
    onSuccess: async (block) => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "saved-blocks"] });
      onOpenChange(false);
      toast(`Block "${block.name}" saved.`);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) save.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader
          title="Save as block"
          description="Saves the selected block. Every template in this workspace can insert it."
        />
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
            if (name) save.mutate(name);
          }}
        >
          <FormError message={errorText(save.error)} />
          <Field id="saved-block-name" label="Name">
            <Input
              id="saved-block-name"
              name="name"
              required
              maxLength={100}
              placeholder="For example, Office hours"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending}>
              Save block
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function usePreview(
  mode: "edit" | "preview",
  produce: () => Promise<string>,
  draft: Draft,
  fields: MergeField[] | undefined,
  brand: BrandSnapshot,
) {
  const [html, setHtml] = useState<string | null>(null);
  const values = useMemo(() => sampleValues(fields), [fields]);
  useEffect(() => {
    if (mode !== "preview") return;
    let live = true;
    setHtml(null);
    void produce().then((raw) => {
      if (live) setHtml(raw);
    });
    return () => {
      live = false;
    };
  }, [mode, produce]);
  // Drafts show the live brand (U13): the brand tokens are filled before the merge tags.
  const branded = html === null ? null : applyBrand(html, brand, "html");
  const subject = applyBrand(draft.subject, brand, "text");
  return {
    html: branded === null ? null : renderMergeTags(branded, values, "html"),
    subject: renderMergeTags(subject, values, "text"),
    preheader: renderMergeTags(applyBrand(draft.preheader, brand, "text"), values, "text"),
    missing: branded === null ? [] : missingMergeTags(`${subject} ${branded}`, values),
  };
}

/** Whether a React drag event carries blocks from the block library. */
function isLibraryDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(LIBRARY_MIME);
}

/**
 * A short message for screen readers (U14). The same message twice in a row gets a
 * trailing space, so the live region reads it again.
 */
function useAnnouncer() {
  const [message, setMessage] = useState("");
  const announce = useCallback(
    (next: string) => setMessage((last) => (last === next ? `${next}\u00a0` : next)),
    [],
  );
  return { message, announce };
}

/** The panel on the right: the selected block, its section, and the email settings. */
function SettingsPanel({
  editor,
  brand,
  fields,
}: {
  editor: Editor;
  brand: BrandSnapshot;
  fields: MergeField[];
}) {
  const selected = useEditorState({ editor, selector: ({ editor: e }) => selectedAtom(e) });
  const section = useEditorState({ editor, selector: ({ editor: e }) => selectedSection(e) });
  const panel = useEditorState({ editor, selector: ({ editor: e }) => selectedPanel(e) });
  return (
    <div className="flex flex-col gap-4">
      {selected ? <BlockSettings editor={editor} block={selected} fields={fields} /> : null}
      {section ? <SectionSettings editor={editor} section={section} /> : null}
      {panel ? <PanelSettings editor={editor} panel={panel} /> : null}
      {!selected && !section && !panel ? (
        <p className="m-0 rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
          Select a block on the canvas to change its settings. Text and headings use the toolbar.
        </p>
      ) : null}
      <section aria-labelledby="email-settings-title" className="flex flex-col gap-3 px-1 pt-2">
        <h2 id="email-settings-title" className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
          Email
        </h2>
        <FontSetting editor={editor} brand={brand} />
      </section>
    </div>
  );
}

const CANVAS_WIDTHS: { id: "desktop" | "mobile"; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: MonitorIcon },
  { id: "mobile", label: "Mobile", icon: SmartphoneIcon },
];

function BlockEditor({
  template,
  starter,
}: {
  template: Template | null;
  starter: GalleryTemplate | null;
}) {
  const { current } = useCurrentWorkspace();
  const fields = useQuery(mergeFieldsQuery(current.id)).data?.items;
  const [draft, setDraft] = useState<Draft>({
    name: template?.name ?? starter?.name ?? "Untitled template",
    subject: template?.subject ?? starter?.subject ?? "",
    preheader: template?.preheader ?? starter?.preheader ?? "",
  });
  const [dirty, setDirty] = useState(template === null);
  // A new template starts as unsaved, but leaving it untouched loses nothing.
  const [edited, setEdited] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  // One size for the canvas and the preview: desktop, mobile, or dark (preview only).
  const [size, setSize] = useState<PreviewMode>("desktop");
  const [dialog, setDialog] = useState<"link" | "block" | "test" | "library" | null>(null);
  const save = useSaveTemplate(template?.id ?? null);
  const { message, announce } = useAnnouncer();
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const editor = useEditor({
    extensions: editorExtensions({ announce: (text) => announceRef.current(text) }),
    content: template
      ? (JSON.parse(template.source) as EmailDocument)
      : (starter?.document() ?? starterDocument()),
    editorProps: {
      attributes: {
        "aria-label": "Email body",
        "aria-describedby": "canvas-keys",
        class: "email-canvas-body",
      },
    },
    onUpdate: () => {
      setDirty(true);
      setEdited(true);
    },
  });
  const docFont = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? documentFont(e) : null),
  });

  const onDraft = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setEdited(true);
  };

  const renderHtml = useMemo(
    () => async () => {
      const { renderEmail } = await loadRenderer();
      return (await renderEmail(documentOf(editor), { preheader: draft.preheader })).html;
    },
    [editor, draft.preheader],
  );
  const brand = useLiveBrand();
  const preview = usePreview(mode, renderHtml, draft, fields, brand);

  async function saveNow(): Promise<Template> {
    const { renderEmail } = await loadRenderer();
    const doc = documentOf(editor);
    const rendered = await renderEmail(doc, { preheader: draft.preheader });
    const saved = await save.mutateAsync({
      name: draft.name.trim() || "Untitled template",
      subject: draft.subject.trim() || null,
      preheader: draft.preheader.trim() || null,
      format: "blocks",
      source: JSON.stringify(doc),
      html: rendered.html,
      text: rendered.text,
    });
    setDirty(false);
    setEdited(false);
    return saved;
  }

  function insertEntry(entry: LibraryEntry) {
    insertBlocks(editor, entry.blocks());
    announce(`${entry.label} added.`);
    if (dialog === "library") setDialog(null);
  }

  /** A library drop on the canvas frame, outside the text: the nearest block boundary. */
  function onCanvasDrop(event: DragEvent) {
    if (event.nativeEvent.defaultPrevented || !isLibraryDrag(event)) return;
    event.preventDefault();
    try {
      const blocks = JSON.parse(event.dataTransfer.getData(LIBRARY_MIME)) as BlockNode[];
      insertBlocks(editor, blocks, boundaryAt(editor, event.clientY), { focus: true });
      announce(`${blockName(blocks[0]?.type ?? "")} added.`);
    } catch {
      // Not a block list: nothing to insert.
    }
  }

  const status = save.isPending ? "Saving..." : dirty ? "Unsaved changes" : "Saved";
  const canvasWidth = size === "mobile" ? "mobile" : "desktop";
  const library = (draggable: boolean) => (
    <BlockLibrary
      editor={editor}
      brand={brand}
      draggable={draggable}
      onInsert={insertEntry}
      onSaveBlock={() => setDialog("block")}
    />
  );

  return (
    <div className="flex flex-col gap-8">
      <UnsavedChangesGuard
        when={dirty && (template !== null || edited) && !save.isPending}
        what="this template"
      />
      <EditorHeader
        draft={draft}
        onDraft={onDraft}
        status={status}
        format="blocks"
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog("test")}>
              <SendIcon className="size-3.5" aria-hidden="true" />
              Send test
            </Button>
            <Button onClick={() => void saveNow().catch(() => undefined)} pending={save.isPending}>
              Save
            </Button>
          </>
        }
      />
      <FormError message={errorText(save.error)} />
      <SubjectFields draft={draft} onDraft={onDraft} fields={fields ?? []} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Editor mode"
            value={mode}
            onChange={setMode}
            options={[
              { id: "edit", label: "Edit", icon: PencilIcon },
              { id: "preview", label: "Preview", icon: EyeIcon },
            ]}
          />
          {mode === "edit" ? (
            <Segmented
              label="Canvas width"
              value={canvasWidth}
              onChange={setSize}
              options={CANVAS_WIDTHS}
            />
          ) : null}
        </div>
        <p className="sr-only" role="status" data-testid="builder-announcer">
          {message}
        </p>
        {mode === "preview" ? (
          <EmailPreview {...preview} mode={size} onModeChange={setSize} />
        ) : (
          <BrandContext.Provider value={brand}>
            <div className="@container/builder">
              <div className="grid items-start gap-5 @min-[700px]/builder:grid-cols-[minmax(0,1fr)_272px] @min-[1040px]/builder:grid-cols-[224px_minmax(0,1fr)_272px]">
                <aside
                  aria-label="Block library"
                  className="hidden @min-[700px]/builder:col-start-2 @min-[700px]/builder:row-start-2 @min-[700px]/builder:block @min-[1040px]/builder:sticky @min-[1040px]/builder:top-6 @min-[1040px]/builder:col-start-1 @min-[1040px]/builder:row-start-1 @min-[1040px]/builder:max-h-[calc(100vh-48px)] @min-[1040px]/builder:overflow-y-auto"
                >
                  {library(true)}
                </aside>
                <div className="overflow-hidden rounded-xl border border-border bg-muted @min-[700px]/builder:col-start-1 @min-[700px]/builder:row-span-2 @min-[700px]/builder:row-start-1 @min-[1040px]/builder:col-start-2 @min-[1040px]/builder:row-span-1">
                  <Toolbar
                    editor={editor}
                    fields={fields ?? []}
                    onLink={() => setDialog("link")}
                    onLibrary={() => setDialog("library")}
                  />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: the frame takes library drops beside the text. Clicks and keys go to the editor. */}
                  <div
                    className="px-3 py-6 sm:px-6"
                    data-testid="canvas"
                    onDragOver={(event) => {
                      if (isLibraryDrag(event)) event.preventDefault();
                    }}
                    onDrop={onCanvasDrop}
                  >
                    <div
                      className={cn(
                        "email-canvas @container relative mx-auto rounded-xl border border-border bg-card py-8 transition-[max-width] duration-(--duration-reveal) ease-(--ease-calm)",
                        canvasWidth === "mobile"
                          ? "max-w-[375px] px-6"
                          : "max-w-[600px] px-6 sm:px-10",
                      )}
                      data-width={canvasWidth}
                      style={
                        docFont === "brand" ? { fontFamily: brandFontStack(brand.font) } : undefined
                      }
                    >
                      <EditorContent editor={editor} />
                      <BlockDragHandle editor={editor} />
                    </div>
                  </div>
                  <p
                    id="canvas-keys"
                    className="m-0 border-t border-hairline px-4 py-2 text-xs text-muted-foreground"
                  >
                    Drag a block by its handle to move it, or press Alt+Shift+Up and Alt+Shift+Down.
                  </p>
                </div>
                <aside
                  aria-label="Settings"
                  className="@min-[700px]/builder:col-start-2 @min-[700px]/builder:row-start-1 @min-[1040px]/builder:sticky @min-[1040px]/builder:top-6 @min-[1040px]/builder:col-start-3"
                >
                  <SettingsPanel editor={editor} brand={brand} fields={fields ?? []} />
                </aside>
              </div>
            </div>
            <LibrarySheet
              open={dialog === "library"}
              onOpenChange={(open) => setDialog(open ? "library" : null)}
            >
              {library(false)}
            </LibrarySheet>
          </BrandContext.Provider>
        )}
      </div>
      <LinkDialog
        editor={editor}
        open={dialog === "link"}
        onOpenChange={(open) => setDialog(open ? "link" : null)}
      />
      <SaveBlockDialog
        editor={editor}
        open={dialog === "block"}
        onOpenChange={(open) => setDialog(open ? "block" : null)}
      />
      <SendTestDialog
        open={dialog === "test"}
        onOpenChange={(open) => setDialog(open ? "test" : null)}
        prepare={async () => (dirty || !template ? (await saveNow()).id : template.id)}
      />
    </div>
  );
}

/** HTML and Markdown templates from the API: a source field and the same preview. */
function SourceEditor({ template }: { template: Template }) {
  const { current } = useCurrentWorkspace();
  const fields = useQuery(mergeFieldsQuery(current.id)).data?.items;
  const [draft, setDraft] = useState<Draft>({
    name: template.name,
    subject: template.subject ?? "",
    preheader: template.preheader ?? "",
  });
  const [source, setSource] = useState(template.source);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [testing, setTesting] = useState(false);
  const save = useSaveTemplate(template.id);
  const [savedHtml, setSavedHtml] = useState(template.html);
  const renderHtml = useMemo(() => async () => savedHtml, [savedHtml]);
  const brand = useLiveBrand();
  const preview = usePreview(mode, renderHtml, draft, fields, brand);

  async function saveNow(): Promise<Template> {
    const saved = await save.mutateAsync({
      name: draft.name.trim() || template.name,
      subject: draft.subject.trim() || null,
      preheader: draft.preheader.trim() || null,
      format: template.format,
      source,
    });
    setSavedHtml(saved.html);
    setSource(saved.source);
    setDirty(false);
    return saved;
  }

  return (
    <div className="flex flex-col gap-8">
      <UnsavedChangesGuard when={dirty && !save.isPending} what="this template" />
      <EditorHeader
        draft={draft}
        onDraft={(next) => {
          setDraft(next);
          setDirty(true);
        }}
        status={save.isPending ? "Saving..." : dirty ? "Unsaved changes" : "Saved"}
        format={template.format}
        actions={
          <>
            <Button variant="outline" onClick={() => setTesting(true)}>
              <SendIcon className="size-3.5" aria-hidden="true" />
              Send test
            </Button>
            <Button onClick={() => void saveNow().catch(() => undefined)} pending={save.isPending}>
              Save
            </Button>
          </>
        }
      />
      <FormError message={errorText(save.error)} />
      <SubjectFields
        draft={draft}
        onDraft={(next) => {
          setDraft(next);
          setDirty(true);
        }}
        fields={fields ?? []}
      />
      <div className="flex flex-col gap-4">
        <Segmented
          label="Editor mode"
          value={mode}
          onChange={setMode}
          options={[
            { id: "edit", label: "Source", icon: PencilIcon },
            { id: "preview", label: "Preview", icon: EyeIcon },
          ]}
        />
        {mode === "preview" ? (
          <>
            {dirty ? (
              <p className="m-0 text-xs text-muted-foreground">
                The preview shows the saved version. Save to see your changes.
              </p>
            ) : null}
            <EmailPreview {...preview} />
          </>
        ) : (
          <Field
            id="template-source"
            label={template.format === "markdown" ? "Markdown" : "HTML"}
            hint="This template came from the API. Envelopen sanitizes the HTML when you save."
          >
            <Textarea
              id="template-source"
              className="min-h-[480px] font-mono text-xs"
              spellCheck={false}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setDirty(true);
              }}
            />
          </Field>
        )}
      </div>
      <SendTestDialog
        open={testing}
        onOpenChange={setTesting}
        prepare={async () => (dirty ? (await saveNow()).id : template.id)}
      />
    </div>
  );
}
