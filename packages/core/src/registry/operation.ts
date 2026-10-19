import type { DbConnection } from "@envelopen/db";
import type { z } from "zod";
import type { AuditTarget } from "../audit";
import type { Principal } from "../principal";
import type { Scope } from "../scopes";
import type { Services } from "../services";

/**
 * Risk class of an operation (KTD9). Every class except `read` writes an audit log row.
 * `external_send` sends email outside the deployment.
 */
export type RiskClass = "read" | "write" | "destructive" | "external_send";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Whether the MCP server exposes the operation as a tool (R67). */
export interface McpClassification {
  class: "now" | "later" | "never";
  /** Why the operation has this class. Required, so every decision is explicit. */
  reason: string;
}

/**
 * The input of every operation is one object. The REST router takes the path
 * parameters from it, and the other fields become the query (GET, DELETE) or the
 * JSON body (POST, PUT, PATCH). Query values arrive as strings, so number and
 * boolean fields of GET and DELETE operations must use `z.coerce`.
 */
export type OperationInputSchema = z.ZodObject;

/** What the service layer gives an operation handler. */
export interface OperationContext {
  principal: Principal;
  db: DbConnection;
  /** Unix milliseconds at the start of the operation. */
  now: number;
  /** Platform services. Use `requireService` to read one. */
  services: Partial<Services>;
}

export interface Operation<
  I extends OperationInputSchema = OperationInputSchema,
  O extends z.ZodType = z.ZodType,
> {
  /** Stable id, `<area>.<verb>`, for example `contacts.upsert`. It is the OpenAPI operationId. */
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly method: HttpMethod;
  /** OpenAPI path under `/api`, with `{name}` parameters, for example `/contacts/{id}`. */
  readonly path: string;
  readonly scope: Scope;
  readonly risk: RiskClass;
  readonly mcp: McpClassification;
  readonly input: I;
  readonly output: O;
  /**
   * The output holds a secret, for example a new API key. The REST router then does not
   * store the response for Idempotency-Key replays, so the secret never rests in D1.
   */
  readonly sensitiveOutput?: boolean;
  /** HTTP status of a success. Defaults to 200. */
  readonly successStatus?: 200 | 201;
  // Method syntax keeps the parameters bivariant, so operations with different
  // schemas fit in one registry array.
  handler(input: z.output<I>, ctx: OperationContext): Promise<z.input<O>>;
  /** The target that the audit row records. Used only when `risk` is not `read`. */
  auditTarget?(input: z.output<I>, output: z.output<O>): AuditTarget | undefined;
}

/** Defines an operation. Add it to the registry so every surface gets it. */
export function defineOperation<I extends OperationInputSchema, O extends z.ZodType>(
  operation: Operation<I, O>,
): Operation<I, O> {
  return operation;
}
