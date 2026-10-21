import {
  backupsGet,
  backupsRuns,
  backupsSetPassphrase,
  backupsStart,
  backupsUpdateSettings,
} from "../backup/operations";
import { campaignsFollowUp } from "../campaigns/follow-up";
import {
  campaignsBatches,
  campaignsCancel,
  campaignsChecklist,
  campaignsConfirm,
  campaignsCreate,
  campaignsDelete,
  campaignsEstimate,
  campaignsGet,
  campaignsList,
  campaignsPause,
  campaignsPrepare,
  campaignsPreview,
  campaignsResume,
  campaignsRetryBatch,
  campaignsSkipBatch,
  campaignsUnschedule,
  campaignsUpdate,
} from "../campaigns/operations";
import {
  connectionsAcceptPolicy,
  connectionsCreate,
  connectionsDelete,
  connectionsGet,
  connectionsList,
  connectionsSelect,
  connectionsSetupEvents,
  connectionsSetWebhookSecret,
  connectionsTest,
  providersList,
} from "../connections/operations";
import {
  campaignsSendTest,
  testAddressesAdd,
  testAddressesList,
  testAddressesRemove,
} from "../connections/test-send";
import { consentList, consentRecord } from "../consent/operations";
import {
  contactsAddTags,
  contactsCount,
  contactsDelete,
  contactsGet,
  contactsList,
  contactsRemoveTag,
  contactsUpdate,
  contactsUpsert,
} from "../contacts/operations";
import {
  domainsCheck,
  domainsCreate,
  domainsDelete,
  domainsGet,
  domainsList,
  domainsUpdate,
} from "../domains/operations";
import { contactsErase, contactsExport } from "../gdpr/operations";
import { exportsCreate, exportsList } from "../import/export";
import {
  importsCreate,
  importsErrorFile,
  importsGet,
  importsList,
  importsPreview,
  importsStart,
} from "../import/operations";
import {
  listsAddContacts,
  listsCreate,
  listsDelete,
  listsList,
  listsRemoveContact,
  listsUpdate,
  tagsCreate,
  tagsDelete,
  tagsList,
  tagsRename,
} from "../lists/operations";
import { settingsGet, settingsUpdate } from "../settings/operations";
import { campaignsClickMap, campaignsStats, statsLatest } from "../stats/operations";
import { suppressionsAdd, suppressionsList, suppressionsRemove } from "../suppression/operations";
import {
  savedBlocksCreate,
  savedBlocksDelete,
  savedBlocksList,
  savedBlocksUpdate,
  templatesCreate,
  templatesDelete,
  templatesDuplicate,
  templatesGet,
  templatesList,
  templatesMergeFields,
  templatesPreview,
  templatesUpdate,
} from "../templates/operations";
import { usageGet } from "../usage/operations";
import { apiKeysCreate, apiKeysList, apiKeysPresets, apiKeysRevoke } from "./operations/api-keys";
import { auditActions, auditList } from "./operations/audit";
import { onboardingStatus } from "./operations/onboarding";
import { workspaceContextGet } from "./operations/workspace-context";
import {
  workspacesArchive,
  workspacesCreate,
  workspacesGet,
  workspacesList,
  workspacesRename,
  workspacesUpdateSettings,
} from "./operations/workspaces";
import { createRegistry } from "./registry";

export {
  defineOperation,
  type HttpMethod,
  type McpClassification,
  type Operation,
  type OperationContext,
  type OperationInputSchema,
  type RiskClass,
} from "./operation";
export {
  ApiKeySchema,
  apiKeysCreate,
  apiKeysList,
  apiKeysPresets,
  apiKeysRevoke,
  CreatedApiKeySchema,
  resolveKeyScopes,
} from "./operations/api-keys";
export { AuditEntrySchema, auditActions, auditList } from "./operations/audit";
export {
  ONBOARDING_GUIDES,
  ONBOARDING_STATUSES,
  ONBOARDING_STEP_IDS,
  type OnboardingStatus,
  OnboardingStatusSchema,
  type OnboardingStepId,
  OnboardingStepSchema,
  onboardingStatus,
  TEST_SEND_ACTION,
} from "./operations/onboarding";
export { WorkspaceContextSchema, workspaceContextGet } from "./operations/workspace-context";
export {
  WorkspaceSchema,
  WorkspaceSummarySchema,
  workspacesArchive,
  workspacesCreate,
  workspacesGet,
  workspacesList,
  workspacesRename,
  workspacesUpdateSettings,
} from "./operations/workspaces";
export {
  createRegistry,
  mcpToolName,
  pathParameters,
  type Registry,
  validateOperation,
} from "./registry";

/**
 * Every operation in Envelopen (R66). The REST routes, the OpenAPI document, the UI
 * client, and the MCP tools all come from this list. Later units add their operations here.
 */
export const registry = createRegistry([
  workspacesGet,
  workspacesUpdateSettings,
  workspacesList,
  workspacesCreate,
  workspacesRename,
  workspacesArchive,
  // Deployment settings (KTD16): the source link of this deployment.
  settingsGet,
  settingsUpdate,
  // Encrypted backups (U4): owner session only, never MCP.
  backupsGet,
  backupsRuns,
  backupsStart,
  backupsSetPassphrase,
  backupsUpdateSettings,
  apiKeysPresets,
  apiKeysList,
  apiKeysCreate,
  apiKeysRevoke,
  auditList,
  auditActions,
  onboardingStatus,
  // Contacts. `contacts.count` comes before `contacts.get`, so /contacts/count is not an id.
  contactsList,
  contactsCount,
  contactsGet,
  contactsUpsert,
  contactsUpdate,
  contactsDelete,
  // Data rights (U17): the JSON export and the erase of one contact (R21).
  contactsExport,
  contactsErase,
  contactsAddTags,
  contactsRemoveTag,
  consentList,
  consentRecord,
  listsList,
  listsCreate,
  listsUpdate,
  listsDelete,
  listsAddContacts,
  listsRemoveContact,
  tagsList,
  tagsCreate,
  tagsRename,
  tagsDelete,
  suppressionsList,
  suppressionsAdd,
  suppressionsRemove,
  importsList,
  importsCreate,
  importsGet,
  importsPreview,
  importsStart,
  importsErrorFile,
  exportsList,
  exportsCreate,
  // Providers, connections, sending domains, and test sends (U7).
  providersList,
  connectionsList,
  connectionsGet,
  connectionsCreate,
  connectionsTest,
  connectionsSelect,
  connectionsAcceptPolicy,
  connectionsSetupEvents,
  connectionsSetWebhookSecret,
  connectionsDelete,
  domainsList,
  domainsGet,
  domainsCreate,
  domainsUpdate,
  domainsCheck,
  domainsDelete,
  testAddressesList,
  testAddressesAdd,
  testAddressesRemove,
  campaignsSendTest,
  // Templates and saved blocks (U8). `templates.merge_fields` comes before
  // `templates.get`, so /templates/merge-fields is not an id.
  templatesList,
  templatesMergeFields,
  templatesGet,
  templatesCreate,
  templatesUpdate,
  templatesDuplicate,
  templatesDelete,
  templatesPreview,
  savedBlocksList,
  savedBlocksCreate,
  savedBlocksUpdate,
  savedBlocksDelete,
  // Campaigns (U9). Send, schedule, and the decisions on uncertain batches use
  // prepare and confirm, or an explicit acceptance of the duplicate risk.
  campaignsList,
  campaignsCreate,
  campaignsGet,
  campaignsUpdate,
  campaignsDelete,
  campaignsEstimate,
  campaignsChecklist,
  campaignsPreview,
  campaignsPrepare,
  campaignsConfirm,
  campaignsUnschedule,
  campaignsPause,
  campaignsResume,
  campaignsCancel,
  campaignsBatches,
  campaignsRetryBatch,
  campaignsSkipBatch,
  // Stats, usage, and follow-ups (U11). Stats and usage read rollups and the UsageMeter
  // with `stats:read`. A follow-up is a draft, sent with prepare and confirm.
  campaignsStats,
  campaignsClickMap,
  campaignsFollowUp,
  statsLatest,
  usageGet,
  // The agent's first call (U16): provider, domain, tracking, usage, and the sending rules.
  workspaceContextGet,
]);
