import {
  ArrowUpRightIcon,
  FileTextIcon,
  type LucideIcon,
  PlugIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { guideUrl } from "@/lib/guides";

// Pages that later units fill (U6 to U9). Each shows a calm empty state with a guide.

function Placeholder({
  title,
  description,
  icon,
  emptyTitle,
  emptyText,
  guide,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyText: string;
  guide: string;
}) {
  return (
    <div className="flex flex-col gap-12">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title={emptyTitle}
        action={
          <Button asChild variant="outline" size="sm">
            <a href={guideUrl(guide)} target="_blank" rel="noreferrer">
              Read the guide
              <ArrowUpRightIcon className="size-3" aria-hidden="true" />
            </a>
          </Button>
        }
      >
        {emptyText}
      </EmptyState>
    </div>
  );
}

export function CampaignsPage() {
  return (
    <Placeholder
      title="Campaigns"
      description="Write, test, schedule, and send campaigns."
      icon={SendIcon}
      emptyTitle="No campaigns yet"
      emptyText="Campaigns arrive in a later release. Connect a provider and import contacts first."
      guide="docs/guides/README.md"
    />
  );
}

export function ContactsPage() {
  return (
    <Placeholder
      title="Contacts"
      description="Your audience, with lists, tags, and consent."
      icon={UsersIcon}
      emptyTitle="No contacts yet"
      emptyText="CSV import and contact lists arrive in a later release."
      guide="docs/guides/import-contacts.md"
    />
  );
}

export function TemplatesPage() {
  return (
    <Placeholder
      title="Templates"
      description="Reusable email designs for your campaigns."
      icon={FileTextIcon}
      emptyTitle="No templates yet"
      emptyText="The email editor and templates arrive in a later release."
      guide="docs/guides/README.md"
    />
  );
}

export function ConnectionsPage() {
  return (
    <Placeholder
      title="Connections"
      description="Email providers and sending domains for this workspace."
      icon={PlugIcon}
      emptyTitle="No provider connected"
      emptyText="Provider connections and domain checks arrive in a later release. The guides explain each provider."
      guide="docs/guides/README.md#email-providers"
    />
  );
}
