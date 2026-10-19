/**
 * Error codes that the service layer uses. Each transport maps them to its own form,
 * for example an HTTP status in the REST router.
 */
export type OperationErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "rate_limited"
  /** An email provider or a DNS resolver failed or did not answer. */
  | "provider_error";

export class OperationError extends Error {
  readonly code: OperationErrorCode;
  readonly details: unknown;

  constructor(code: OperationErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.details = details;
  }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}
