import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SendIcon } from "lucide-react";
import type { Schemas } from "@/api/client";
import { campaignsQuery } from "@/api/queries";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useCurrentWorkspace } from "@/components/workspace-context";
import { errorText, Figure, PageTop } from "@/features/contacts/shared";
import { CampaignStatusPill, formatWhen } from "./shared";

// The campaigns of the workspace, newest first (R31 to R34).

export function CampaignsPage() {
  const { current } = useCurrentWorkspace();
  const campaigns = useQuery(campaignsQuery(current.id));
  const items = campaigns.data?.items ?? [];

  return (
    <div className="flex flex-col gap-12">
      <PageTop
        title="Campaigns"
        description="Write, test, schedule, and send campaigns."
        actions={
          <Button asChild>
            <Link to="/campaigns/new">
              <PlusIcon className="size-3.5" aria-hidden="true" />
              New campaign
            </Link>
          </Button>
        }
      />
      <FormError message={errorText(campaigns.error)} />
      {campaigns.isPending ? (
        <TableSkeleton label="Loading the campaigns" columns={5} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={SendIcon}
          title="No campaigns yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/campaigns/new">Create your first campaign</Link>
            </Button>
          }
        >
          Pick a template and the lists or tags to send to. Envelopen checks the email, shows how
          many contacts it reaches, and asks you to confirm before it sends.
        </EmptyState>
      ) : (
        <CampaignTable items={items} />
      )}
    </div>
  );
}

export function CampaignTable({ items }: { items: Schemas["CampaignSummary"][] }) {
  return (
    <Table aria-label="Campaigns">
      <thead>
        <tr>
          <TableHead>Campaign</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Recipients</TableHead>
          <TableHead className="text-right">Sent</TableHead>
          <TableHead>When</TableHead>
        </tr>
      </thead>
      <tbody>
        {items.map((campaign) => (
          <TableRow key={campaign.id} data-testid="campaign-row">
            <TableCell className="min-w-[200px] font-medium">
              <Link
                to="/campaigns/$campaignId"
                params={{ campaignId: String(campaign.id) }}
                className="hover:underline"
              >
                {campaign.name}
              </Link>
            </TableCell>
            <TableCell>
              <CampaignStatusPill status={campaign.status} />
            </TableCell>
            <TableCell className="text-right">
              {campaign.recipientCount === null ? (
                <span className="text-muted-foreground">-</span>
              ) : (
                <Figure value={campaign.recipientCount} />
              )}
            </TableCell>
            <TableCell className="text-right">
              <Figure value={campaign.sent} />
            </TableCell>
            <TableCell className="figure text-muted-foreground">
              {formatWhen(campaign.startedAt ?? campaign.scheduledAt ?? campaign.updatedAt)}
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}
