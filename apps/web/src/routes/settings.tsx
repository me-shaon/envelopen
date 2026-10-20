import { PageHeader } from "@/components/page-header";
import { AuditLogSection } from "@/features/audit/audit-log-page";
import { ApiKeysSection } from "@/features/settings/api-keys-section";
import { TrackingSection } from "@/features/settings/tracking-section";
import { WorkspacesSection } from "@/features/settings/workspaces-section";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Settings"
        description="Workspaces, tracking, API keys, and the audit log."
      />
      <WorkspacesSection />
      <TrackingSection />
      <ApiKeysSection />
      <AuditLogSection />
      <footer className="text-xs text-muted-foreground">Envelopen {__ENVELOPEN_VERSION__}</footer>
    </div>
  );
}
