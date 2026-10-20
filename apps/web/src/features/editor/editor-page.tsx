import {
  type BlockNode,
  type BlockType,
  defaultBlock,
  type EmailDocument,
  starterDocument,
} from "@envelopen/email-render/blocks/types";
import { missingMergeTags, renderMergeTags } from "@envelopen/email-render/merge-tags";
import { previewValues } from "@envelopen/email-render/personalize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  ArrowLeftIcon,
  BoldIcon,
  BookmarkPlusIcon,
  BracesIcon,
  CodeIcon,
  Columns2Icon,
  EyeIcon,
  HeadingIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  type LucideIcon,
  MinusIcon,
  MousePointerClickIcon,
  MoveVerticalIcon,
  PanelBottomIcon,
  PencilIcon,
  PilcrowIcon,
  PlusIcon,
  Redo2Icon,
  SendIcon,
  Share2Icon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { mergeFieldsQuery, savedBlocksQuery, templateQuery } from "@/api/queries";
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
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText } from "@/features/contacts/shared";
import { cn } from "@/lib/utils";
import { BlockSettings } from "./block-settings";
import { currentBlock, documentOf, insertBlocks, selectedAtom } from "./doc";
import { editorExtensions } from "./extensions";
import { EmailPreview, Segmented } from "./preview";
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

const BLOCKS: { type: BlockType; label: string; icon: LucideIcon }[] = [
  { type: "heading", label: "Heading", icon: HeadingIcon },
  { type: "paragraph", label: "Paragraph", icon: PilcrowIcon },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "button", label: "Button", icon: MousePointerClickIcon },
  { type: "divider", label: "Divider", icon: MinusIcon },
  { type: "spacer", label: "Spacer", icon: MoveVerticalIcon },
  { type: "columns", label: "Two columns", icon: Columns2Icon },
  { type: "social", label: "Social links", icon: Share2Icon },
  { type: "footer", label: "Footer", icon: PanelBottomIcon },
  { type: "html", label: "Raw HTML", icon: CodeIcon },
];

/** The renderer is large (React Email and react-dom/server), so it loads on first use. */
function loadRenderer() {
  return import("@envelopen/email-render/render");
}

/** Sample merge values: the standard fields have samples, custom fields stay empty. */
function sampleValues(fields: MergeField[] | undefined) {
  const values: Record<string, string | null> = {};
  for (const field of fields ?? []) if (field.kind !== "reserved") values[field.key] = field.sample;
  return previewValues(values, window.location.origin);
}

interface Draft {
  name: string;
  subject: string;
  preheader: string;
}

/** The route component: /templates/new starts a template, /templates/<id> opens one. */
export function EditorRoute() {
  const { templateId } = useParams({ strict: false }) as { templateId?: string };
  const id = Number(templateId);
  return (
    <EditorPage
      // A new key per template, so the editor starts fresh when the id changes.
      key={templateId ?? "new"}
      templateId={Number.isSafeInteger(id) && id > 0 ? id : null}
    />
  );
}

/** Loads the template, or starts a new one, then shows the editor for its format. */
export function EditorPage({ templateId }: { templateId: number | null }) {
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
  return <BlockEditor template={data} />;
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
    { title: "Contact fields", items: fields.filter((f) => f.kind !== "reserved") },
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
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
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
}: {
  editor: Editor;
  fields: MergeField[];
  onLink: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
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

function BlockPanel({ editor, onSaveBlock }: { editor: Editor; onSaveBlock: () => void }) {
  const { current } = useCurrentWorkspace();
  const saved = useQuery(savedBlocksQuery(current.id));
  const items = saved.data?.items ?? [];
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="block-panel-title" className="flex flex-col gap-3">
        <h2 id="block-panel-title" className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
          Blocks
        </h2>
        <div className="grid grid-cols-2 gap-1.5">
          {BLOCKS.map((block) => {
            const Icon = block.icon;
            return (
              <button
                key={block.type}
                type="button"
                aria-label={`Add ${block.label.toLowerCase()}`}
                onClick={() => insertBlocks(editor, [defaultBlock(block.type)])}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-left text-[12.5px] transition-colors hover:bg-accent"
              >
                <Icon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {block.label}
              </button>
            );
          })}
        </div>
      </section>
      <section aria-labelledby="saved-panel-title" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="saved-panel-title" className="m-0 text-[14px] font-semibold tracking-[-0.01em]">
            Saved blocks
          </h2>
          <Button variant="ghost" size="sm" onClick={onSaveBlock}>
            <BookmarkPlusIcon className="size-3.5" aria-hidden="true" />
            Save as block
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="m-0 text-[12.5px] text-muted-foreground">
            Select a block and save it to reuse it in other templates.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Saved blocks">
            {items.map((block) => (
              <li
                key={block.id}
                className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{block.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Insert ${block.name}`}
                  onClick={() => insertBlocks(editor, JSON.parse(block.content) as BlockNode[])}
                >
                  <PlusIcon className="size-3.5" aria-hidden="true" />
                  Insert
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ws", current.id, "saved-blocks"] });
      onOpenChange(false);
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
  return {
    html: html === null ? null : renderMergeTags(html, values, "html"),
    subject: renderMergeTags(draft.subject, values, "text"),
    preheader: renderMergeTags(draft.preheader, values, "text"),
    missing: html === null ? [] : missingMergeTags(`${draft.subject} ${html}`, values),
  };
}

function BlockEditor({ template }: { template: Template | null }) {
  const { current } = useCurrentWorkspace();
  const fields = useQuery(mergeFieldsQuery(current.id)).data?.items;
  const [draft, setDraft] = useState<Draft>({
    name: template?.name ?? "Untitled template",
    subject: template?.subject ?? "",
    preheader: template?.preheader ?? "",
  });
  const [dirty, setDirty] = useState(template === null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [dialog, setDialog] = useState<"link" | "block" | "test" | null>(null);
  const save = useSaveTemplate(template?.id ?? null);

  const editor = useEditor({
    extensions: editorExtensions(),
    content: template ? (JSON.parse(template.source) as EmailDocument) : starterDocument(),
    editorProps: {
      attributes: {
        "aria-label": "Email body",
        class: "email-canvas-body",
      },
    },
    onUpdate: () => setDirty(true),
  });
  const selected = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? selectedAtom(e) : null),
  });

  const onDraft = (next: Draft) => {
    setDraft(next);
    setDirty(true);
  };

  const renderHtml = useMemo(
    () => async () => {
      const { renderEmail } = await loadRenderer();
      return (await renderEmail(documentOf(editor), { preheader: draft.preheader })).html;
    },
    [editor, draft.preheader],
  );
  const preview = usePreview(mode, renderHtml, draft, fields);

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
    return saved;
  }

  const status = save.isPending ? "Saving..." : dirty ? "Unsaved changes" : "Saved";

  return (
    <div className="flex flex-col gap-8">
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
        <Segmented
          label="Editor mode"
          value={mode}
          onChange={setMode}
          options={[
            { id: "edit", label: "Edit", icon: PencilIcon },
            { id: "preview", label: "Preview", icon: EyeIcon },
          ]}
        />
        {mode === "preview" ? (
          <EmailPreview {...preview} />
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_288px]">
            <div className="overflow-hidden rounded-xl border border-border bg-muted">
              <Toolbar editor={editor} fields={fields ?? []} onLink={() => setDialog("link")} />
              <div className="px-3 py-6 sm:px-6">
                <div className="email-canvas mx-auto max-w-[600px] rounded-xl border border-border bg-card px-6 py-8 sm:px-10">
                  <EditorContent editor={editor} />
                </div>
              </div>
            </div>
            <aside
              aria-label="Blocks and settings"
              className="flex flex-col gap-6 lg:sticky lg:top-6"
            >
              {selected ? (
                <BlockSettings editor={editor} block={selected} fields={fields ?? []} />
              ) : null}
              <BlockPanel editor={editor} onSaveBlock={() => setDialog("block")} />
            </aside>
          </div>
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
  const preview = usePreview(mode, renderHtml, draft, fields);

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
