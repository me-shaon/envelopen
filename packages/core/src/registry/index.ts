import { apiKeysCreate, apiKeysList, apiKeysPresets, apiKeysRevoke } from "./operations/api-keys";
import { auditList } from "./operations/audit";
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
]);
