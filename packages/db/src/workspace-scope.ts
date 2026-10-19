import type {
  Kysely,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import { TENANT_TABLES } from "./schema";

/** Thrown when a query on a tenant table has no `workspace_id` condition (KTD4). */
export class WorkspaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceScopeError";
  }
}

const WORKSPACE_COLUMN = "workspace_id";
// Operators that restrict rows to given workspaces. `is not`, `<>`, and others do not.
const SCOPING_OPERATORS = new Set(["=", "==", "in"]);

// Kysely node shapes, read loosely so the walker also handles nodes it does not know.
type AnyNode = OperationNode & Record<string, unknown>;

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as AnyNode).kind === "string";
}

function child(node: AnyNode, key: string): AnyNode | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function children(node: AnyNode, key: string): AnyNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** The table name of a TableNode, possibly under an AliasNode. Other sources return undefined. */
function tableName(node: AnyNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "AliasNode") return tableName(child(node, "node"));
  if (node.kind !== "TableNode") return undefined;
  const identifier = child(child(node, "table") ?? node, "identifier");
  const name = identifier?.name;
  return typeof name === "string" ? name : undefined;
}

/** True when the operand is a reference to a `workspace_id` column, with or without a table. */
function isWorkspaceColumn(node: AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.kind === "ReferenceNode") return isWorkspaceColumn(child(node, "column"));
  if (node.kind === "ColumnNode") return child(node, "column")?.name === WORKSPACE_COLUMN;
  return false;
}

function isColumn(node: AnyNode | undefined): boolean {
  return node?.kind === "ReferenceNode" || node?.kind === "ColumnNode";
}

/**
 * True when the filter restricts rows to given workspaces. An AND needs one scoped side.
 * An OR needs both sides scoped, because one unscoped branch opens every workspace.
 */
function isScopedFilter(node: AnyNode | undefined): boolean {
  if (!node) return false;
  switch (node.kind) {
    case "WhereNode":
      return isScopedFilter(child(node, "where"));
    case "OnNode":
      return isScopedFilter(child(node, "on"));
    case "ParensNode":
      return isScopedFilter(child(node, "node"));
    case "AndNode":
      return isScopedFilter(child(node, "left")) || isScopedFilter(child(node, "right"));
    case "OrNode":
      return isScopedFilter(child(node, "left")) && isScopedFilter(child(node, "right"));
    case "BinaryOperationNode": {
      const operator = child(node, "operator")?.operator;
      if (typeof operator !== "string" || !SCOPING_OPERATORS.has(operator)) return false;
      const left = child(node, "leftOperand");
      const right = child(node, "rightOperand");
      // The other side must be a value, a list, or a subquery. A column-to-column match,
      // such as `a.workspace_id = b.workspace_id` in a join, does not pick a workspace.
      if (isWorkspaceColumn(left)) return !isColumn(right);
      return operator !== "in" && isWorkspaceColumn(right) && !isColumn(left);
    }
    case "RawNode":
      // A raw filter fragment, for example sql`workspace_id = ${id}`.
      return rawText(node).includes(WORKSPACE_COLUMN);
    default:
      return false;
  }
}

function rawText(node: AnyNode): string {
  const fragments = node.sqlFragments;
  return Array.isArray(fragments) ? fragments.join(" ") : "";
}

function tenantTablesIn(sources: Array<AnyNode | undefined>): string[] {
  const names: string[] = [];
  for (const source of sources) {
    const name = tableName(source);
    if (name && TENANT_TABLES.has(name)) names.push(name);
  }
  return names;
}

function fail(kind: string, tables: string[]): never {
  throw new WorkspaceScopeError(
    `${kind} on tenant table ${tables.join(", ")} has no ${WORKSPACE_COLUMN} condition. ` +
      "Add one, or use unscoped(db) for a deliberate cross-workspace query.",
  );
}

/** Checks one query node, without descending into nested queries. */
function checkQuery(node: AnyNode): void {
  switch (node.kind) {
    case "SelectQueryNode":
    case "UpdateQueryNode":
    case "DeleteQueryNode": {
      const joins = children(node, "joins");
      const sources = [
        child(node, "table"),
        ...children(child(node, "from") ?? node, "froms"),
        ...children(child(node, "using") ?? node, "tables"),
        ...joins.map((join) => child(join, "table")),
      ];
      const tables = tenantTablesIn(sources);
      if (tables.length === 0) return;
      const filters = [child(node, "where"), ...joins.map((join) => child(join, "on"))];
      if (!filters.some(isScopedFilter)) fail(node.kind, tables);
      return;
    }
    case "InsertQueryNode": {
      const tables = tenantTablesIn([child(node, "into")]);
      if (tables.length === 0) return;
      const hasColumn = children(node, "columns").some(isWorkspaceColumn);
      if (!hasColumn) fail(node.kind, tables);
      return;
    }
    case "MergeQueryNode": {
      const tables = tenantTablesIn([child(node, "into")]);
      const using = child(node, "using");
      if (tables.length > 0 && !isScopedFilter(child(using ?? node, "on"))) fail(node.kind, tables);
      return;
    }
    default:
      return;
  }
}

/** Walks the whole tree, so subqueries and CTEs are checked as queries of their own. */
function walk(node: AnyNode): void {
  checkQuery(node);
  for (const value of Object.values(node)) {
    if (isNode(value)) walk(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) walk(item);
  }
}

const TENANT_TABLE_PATTERN = new RegExp(`(?<![\\w.])"?(${[...TENANT_TABLES].join("|")})"?\\b`, "i");

/** A whole query written with sql``: check the table names that its text mentions. */
function checkRawQuery(node: AnyNode): void {
  const text = rawText(node);
  const match = TENANT_TABLE_PATTERN.exec(text);
  if (match?.[1] && !text.includes(WORKSPACE_COLUMN)) fail("Raw query", [match[1]]);
}

/**
 * Kysely plugin that fails any query on a tenant table without a `workspace_id`
 * condition (KTD4). Tests enable it through `createDb(env, { enforceWorkspaceScope: true })`.
 * It reads the operation tree and never changes the query.
 */
export class WorkspaceScopePlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const root = args.node as unknown as AnyNode;
    if (root.kind === "RawNode") checkRawQuery(root);
    else walk(root);
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/**
 * Returns the same database without plugins, so the scope check does not apply.
 * Use it only for deliberate cross-workspace queries, such as the recovery sweep
 * or the list of a user's workspaces. Metering still applies, because it wraps the binding.
 */
export function unscoped<DB>(db: Kysely<DB>): Kysely<DB> {
  return db.withoutPlugins();
}
