import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BlocksIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { api, type Schemas, unwrap } from "@/api/client";
import { savedBlocksQuery, templatesQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, PageTop } from "@/features/contacts/shared";
import { formatDate } from "@/lib/format";
import { presenceClass, usePresence } from "@/lib/motion";

// Templates and saved blocks of the workspace (R28). The editor opens at
// /templates/$templateId, and /templates/new starts a template from the starter blocks.

type Format = Schemas["TemplateFormat"];
type TemplateItem = Schemas["TemplateSummary"];
type BlockItem = Schemas["SavedBlockList"]["items"][number];

const NO_TEMPLATES: TemplateItem[] = [];
const NO_BLOCKS: BlockItem[] = [];
const byId = (item: { id: number }) => item.id;

const FORMATS: Record<Format, { label: string; tone: Tone }> = {
  blocks: { label: "Blocks", tone: "lavender" },
  html: { label: "HTML", tone: "salmon" },
  markdown: { label: "Markdown", tone: "teal" },
};

export function FormatPill({ format }: { format: Format }) {
  const item = FORMATS[format];
  return <Pill tone={item.tone}>{item.label}</Pill>;
}

export function TemplatesPage() {
  const { current } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery(templatesQuery(current.id));
  const blocks = useQuery(savedBlocksQuery(current.id));
  const [deleting, setDeleting] = useState<{
    id: number;
    name: string;
    kind: "template" | "block";
  } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ws", current.id] });

  const duplicate = useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST("/templates/{id}/duplicate", { params: { path: { id } }, body: {} })),
    onSuccess: async (copy) => {
      await refresh();
      toast(`Template duplicated as "${copy.name}".`);
    },
    // A row action has no place for an inline error, so the error is a toast.
    onError: (error, id) => {
      const name = templates.data?.items.find((item) => item.id === id)?.name ?? "the template";
      toast.error(`"${name}" was not duplicated. ${errorText(error)}`, {
        retry: () => duplicate.mutate(id),
      });
    },
  });
  const remove = useMutation({
    mutationFn: (item: {
      id: number;
      name: string;
      kind: "template" | "block";
    }): Promise<unknown> =>
      item.kind === "template"
        ? unwrap(api.DELETE("/templates/{id}", { params: { path: { id: item.id } } }))
        : unwrap(api.DELETE("/saved-blocks/{id}", { params: { path: { id: item.id } } })),
    onSuccess: async (_data, item) => {
      setDeleting(null);
      await refresh();
      toast(`${item.kind === "template" ? "Template" : "Block"} "${item.name}" deleted.`);
    },
  });

  // New rows fade in, deleted rows fade out.
  const items = usePresence(templates.data?.items ?? NO_TEMPLATES, byId, templates.isSuccess);
  const saved = usePresence(blocks.data?.items ?? NO_BLOCKS, byId, blocks.isSuccess);

  return (
    <div className="flex flex-col gap-12">
      <PageTop
        title="Templates"
        description="Reusable email designs, with merge tags and saved blocks."
        actions={
          <Button
            onClick={() =>
              void navigate({ to: "/templates/$templateId", params: { templateId: "new" } })
            }
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New template
          </Button>
        }
      />

      {templates.isPending ? (
        <TableSkeleton label="Loading the templates" rows={4} columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileTextIcon}
          title="No templates yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/templates/$templateId" params={{ templateId: "new" }}>
                Write your first template
              </Link>
            </Button>
          }
        >
          Build an email from blocks: headings, text, images, buttons, columns, and a footer with
          the unsubscribe link. Agents can also create templates from HTML or Markdown.
        </EmptyState>
      ) : (
        <Table aria-label="Templates">
          <thead>
            <tr>
              <TableHead>Template</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {items.map(({ key, item: template, state }) => (
              <TableRow
                key={key}
                data-testid={state === "exit" ? undefined : "template-row"}
                className={presenceClass(state)}
              >
                <TableCell className="font-medium">
                  <Link
                    to="/templates/$templateId"
                    params={{ templateId: String(template.id) }}
                    className="hover:underline"
                  >
                    {template.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[280px] truncate text-muted-foreground">
                  {template.subject || "No subject"}
                </TableCell>
                <TableCell>
                  <FormatPill format={template.format} />
                </TableCell>
                <TableCell className="figure text-muted-foreground">
                  {formatDate(template.updatedAt)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    pending={duplicate.isPending && duplicate.variables === template.id}
                    disabled={duplicate.isPending}
                    onClick={() => duplicate.mutate(template.id)}
                  >
                    Duplicate<span className="sr-only"> {template.name}</span>
                  </Button>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    onClick={() =>
                      setDeleting({ id: template.id, name: template.name, kind: "template" })
                    }
                  >
                    Delete<span className="sr-only"> {template.name}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      <section aria-labelledby="saved-blocks-title" className="flex flex-col gap-4">
        <SectionHeader
          id="saved-blocks-title"
          title="Saved blocks"
          aside="Save a block in the editor to reuse it in any template"
        />
        {saved.length === 0 ? (
          <EmptyState icon={BlocksIcon} title="No saved blocks yet">
            Select a block in the editor and choose “Save as block”. A saved block appears in the
            block panel of every template in this workspace.
          </EmptyState>
        ) : (
          <Table aria-label="Saved blocks">
            <thead>
              <tr>
                <TableHead>Block</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {saved.map(({ key, item: block, state }) => (
                <TableRow
                  key={key}
                  data-testid={state === "exit" ? undefined : "saved-block-row"}
                  className={presenceClass(state)}
                >
                  <TableCell className="font-medium">{block.name}</TableCell>
                  <TableCell className="figure text-muted-foreground">
                    {formatDate(block.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive-ghost"
                      size="sm"
                      onClick={() => setDeleting({ id: block.id, name: block.name, kind: "block" })}
                    >
                      Delete<span className="sr-only"> {block.name}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDeleting(null);
          remove.reset();
        }}
        title={`Delete ${deleting?.name ?? "this item"}?`}
        description={
          deleting?.kind === "block"
            ? "The block leaves the block panel. Templates that use the block keep their copy. You cannot undo this."
            : "The template is deleted. Campaigns keep their own copy of the content. You cannot undo this."
        }
        confirmLabel={deleting?.kind === "block" ? "Delete block" : "Delete template"}
        pending={remove.isPending}
        error={errorText(remove.error)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
