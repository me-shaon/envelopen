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
import { FormError } from "@/components/ui/field";
import { Pill, type Tone } from "@/components/ui/pill";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, PageTop } from "@/features/contacts/shared";
import { formatDate } from "@/lib/format";

// Templates and saved blocks of the workspace (R28). The editor opens at
// /templates/$templateId, and /templates/new starts a template from the starter blocks.

type Format = Schemas["TemplateFormat"];

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
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (item: { id: number; kind: "template" | "block" }): Promise<unknown> =>
      item.kind === "template"
        ? unwrap(api.DELETE("/templates/{id}", { params: { path: { id: item.id } } }))
        : unwrap(api.DELETE("/saved-blocks/{id}", { params: { path: { id: item.id } } })),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  const items = templates.data?.items ?? [];
  const saved = blocks.data?.items ?? [];

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
      <FormError message={errorText(duplicate.error) ?? errorText(remove.error)} />

      {templates.isPending ? (
        <div className="h-32 rounded-xl border border-border bg-muted" />
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
            {items.map((template) => (
              <TableRow key={template.id} data-testid="template-row">
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
              {saved.map((block) => (
                <TableRow key={block.id} data-testid="saved-block-row">
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
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "this item"}?`}
        description={
          deleting?.kind === "block"
            ? "Templates that use the block keep their copy."
            : "Campaigns keep their own copy of the content."
        }
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
