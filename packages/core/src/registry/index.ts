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
import { suppressionsAdd, suppressionsList, suppressionsRemove } from "../suppression/operations";
import { apiKeysCreate, apiKeysList, apiKeysPresets, apiKeysRevoke } from "./operations/api-keys";
import { auditList } from "./operations/audit";
import { onboardingStatus } from "./operations/onboarding";
import {
  workspacesArchive,
  workspacesCreate,
  workspacesGet,
  workspacesList,
  workspacesRename,
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
export { AuditEntrySchema, auditList } from "./operations/audit";
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
export {
  WorkspaceSchema,
  WorkspaceSummarySchema,
  workspacesArchive,
  workspacesCreate,
  workspacesGet,
  workspacesList,
  workspacesRename,
} from "./operations/workspaces";
export { createRegistry, pathParameters, type Registry, validateOperation } from "./registry";

/**
 * Every operation in Envelopen (R66). The REST routes, the OpenAPI document, the UI
 * client, and the MCP tools all come from this list. Later units add their operations here.
 */
export const registry = createRegistry([
  workspacesGet,
  workspacesList,
  workspacesCreate,
  workspacesRename,
  workspacesArchive,
  apiKeysPresets,
  apiKeysList,
  apiKeysCreate,
  apiKeysRevoke,
  auditList,
  onboardingStatus,
  // Contacts. `contacts.count` comes before `contacts.get`, so /contacts/count is not an id.
  contactsList,
  contactsCount,
  contactsGet,
  contactsUpsert,
  contactsUpdate,
  contactsDelete,
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
]);
