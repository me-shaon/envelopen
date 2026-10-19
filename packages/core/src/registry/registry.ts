import { isScope } from "../scopes";
import type { Operation } from "./operation";

export interface Registry {
  readonly operations: readonly Operation[];
  get(id: string): Operation | undefined;
}

const ID_PATTERN = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const PATH_PATTERN = /^(\/([a-z0-9-]+|\{[a-zA-Z][a-zA-Z0-9_]*\}))+$/;
const MCP_CLASSES = new Set(["now", "later", "never"]);
const RISK_CLASSES = new Set(["read", "write", "destructive", "external_send"]);
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The MCP tool name of an operation: the override, or the id with underscores. */
export function mcpToolName(operation: Operation): string {
  return operation.mcp.tool ?? operation.id.replaceAll(".", "_");
}

/** The `{name}` parameters of an operation path, in order. */
export function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
}

/** Returns the problems with one operation definition. An empty list means it is valid. */
export function validateOperation(operation: Operation): string[] {
  const problems: string[] = [];
  const where = `Operation ${operation.id || "(no id)"}`;
  if (!ID_PATTERN.test(operation.id)) problems.push(`${where}: the id must look like "area.verb".`);
  if (!operation.summary?.trim()) problems.push(`${where}: the summary is empty.`);
  if (!METHODS.has(operation.method)) problems.push(`${where}: unknown method.`);
  if (!PATH_PATTERN.test(operation.path)) problems.push(`${where}: the path is not valid.`);
  if (!isScope(operation.scope)) problems.push(`${where}: unknown scope "${operation.scope}".`);
  if (!RISK_CLASSES.has(operation.risk)) problems.push(`${where}: unknown risk class.`);
  if (!operation.mcp || !MCP_CLASSES.has(operation.mcp.class)) {
    problems.push(`${where}: the MCP classification must be now, later, or never.`);
  } else if (!operation.mcp.reason?.trim()) {
    problems.push(`${where}: the MCP classification has no reason.`);
  } else if (!TOOL_PATTERN.test(mcpToolName(operation))) {
    problems.push(`${where}: the MCP tool name is not valid.`);
  }
  const shape = operation.input?.shape ?? {};
  for (const name of pathParameters(operation.path)) {
    if (!(name in shape)) problems.push(`${where}: path parameter "${name}" is not in the input.`);
  }
  return problems;
}

/**
 * Creates a registry and checks every definition. It throws on an invalid
 * definition, a duplicate id, or two operations on the same method and path.
 */
export function createRegistry(operations: readonly Operation[]): Registry {
  const problems = operations.flatMap(validateOperation);
  const byId = new Map<string, Operation>();
  const routes = new Set<string>();
  const tools = new Set<string>();
  for (const operation of operations) {
    if (byId.has(operation.id)) problems.push(`Duplicate operation id ${operation.id}.`);
    byId.set(operation.id, operation);
    if (operation.mcp?.class === "now") {
      const tool = mcpToolName(operation);
      if (tools.has(tool)) problems.push(`Duplicate MCP tool name ${tool} (${operation.id}).`);
      tools.add(tool);
    }
    // `{id}` and `{contactId}` match the same requests, so compare the paths without names.
    const route = `${operation.method} ${operation.path.replaceAll(/\{[^}]+\}/g, "{}")}`;
    if (routes.has(route)) problems.push(`Duplicate route ${route} (${operation.id}).`);
    routes.add(route);
  }
  if (problems.length > 0) throw new Error(`Invalid operation registry:\n${problems.join("\n")}`);
  return {
    operations: Object.freeze([...operations]),
    get: (id) => byId.get(id),
  };
}
