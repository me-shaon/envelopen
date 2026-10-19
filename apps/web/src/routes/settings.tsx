import { PageHeader } from "@/components/page-header";
import { ApiKeysSection } from "@/features/settings/api-keys-section";
import { TrackingSection } from "@/features/settings/tracking-section";
import { WorkspacesSection } from "@/features/settings/workspaces-section";

export function SettingsPage() {
  return (
    <div className="flex max-w-[760px] flex-col gap-12">
      <PageHeader title="Settings" description="Workspaces, tracking, and API keys." />
      <WorkspacesSection />
      <TrackingSection />
      <ApiKeysSection />
    </div>
  );
}
