import { auditList } from "./operations/audit";
import { workspacesGet } from "./operations/workspaces";
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
export { AuditEntrySchema, auditList } from "./operations/audit";
export { WorkspaceSchema, workspacesGet } from "./operations/workspaces";
export { createRegistry, pathParameters, type Registry, validateOperation } from "./registry";

/**
 * Every operation in Envelopen (R66). The REST routes, the OpenAPI document, the UI
 * client, and the MCP tools all come from this list. Later units add their operations here.
 */
export const registry = createRegistry([workspacesGet, auditList]);
