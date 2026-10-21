import { PageHeader } from "@/components/page-header";
import { AuditLogSection } from "@/features/audit/audit-log-page";
import { ApiKeysSection } from "@/features/settings/api-keys-section";
import { BackupSection } from "@/features/settings/backup-section";
import { SourceCodeSection } from "@/features/settings/source-code-section";
import { TrackingSection } from "@/features/settings/tracking-section";
import { WorkersPlanSection } from "@/features/settings/workers-plan-section";
import { WorkspacesSection } from "@/features/settings/workspaces-section";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Settings"
        description="Workspaces, tracking, API keys, backups, the Workers plan, the source code link, and the audit log."
      />
      <WorkspacesSection />
      <TrackingSection />
      <ApiKeysSection />
      <BackupSection />
      <WorkersPlanSection />
      <SourceCodeSection />
      <AuditLogSection />
    </div>
  );
}
