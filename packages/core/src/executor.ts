import type { DbConnection } from "@envelopen/db";
import type { z } from "zod";
import { writeAudit } from "./audit";
import { OperationError } from "./errors";
import type { Principal } from "./principal";
import type { Operation, OperationInputSchema } from "./registry/operation";
import type { Services } from "./services";

export interface OperationDeps {
  db: DbConnection;
  /** R2, the email hasher, the import Workflow, and file links. Each one is optional. */
  services?: Partial<Services>;
  /** The client IP for the audit log, when the transport knows it. */
  ip?: string | null;
  /** Clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Runs an operation for a principal. This is the only place that grants access
 * (KTD10): every surface (UI, REST, MCP) calls it, and no transport checks scopes.
 *
 * 1. Checks the scope, before the input is even read.
 * 2. Rejects an MCP call to an operation that is not classified "now".
 * 3. Validates the input, runs the handler, and validates the output. The output
 *    schema strips fields that it does not declare.
 * 4. Writes an audit log row for every risk class except `read`.
 *
 * The audit row is written after the handler succeeds. A handler that must commit
 * its write and the audit row together can add `auditInsert()` to its own atomic group
 * in a later unit. Then this step needs an opt-out flag on the operation.
 */
export async function runOperation<I extends OperationInputSchema, O extends z.ZodType>(
  principal: Principal,
  operation: Operation<I, O>,
  input: unknown,
  deps: OperationDeps,
): Promise<z.output<O>> {
  if (!principal.scopes.has(operation.scope)) {
    throw new OperationError("forbidden", `This action needs the ${operation.scope} scope.`, {
      requiredScope: operation.scope,
    });
  }
  if (principal.surface === "mcp" && operation.mcp.class !== "now") {
    throw new OperationError("forbidden", `${operation.id} is not available through MCP.`);
  }

  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    throw new OperationError("invalid_input", "The input is not valid.", parsed.error.issues);
  }

  const now = (deps.now ?? Date.now)();
  const result = await operation.handler(parsed.data, {
    principal,
    db: deps.db,
    now,
    services: deps.services ?? {},
  });
  const output = operation.output.parse(result) as z.output<O>;

  if (operation.risk !== "read") {
    const target = operation.auditTarget?.(parsed.data, output) ?? {};
    await writeAudit(deps.db.db, principal, { ...target, action: operation.id, ip: deps.ip });
  }
  return output;
}
