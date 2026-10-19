import type { OperationErrorCode } from "@envelopen/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/** Error codes of the REST API: the service codes and the transport codes. */
export type ApiErrorCode =
  | OperationErrorCode
  | "cross_origin"
  | "idempotency_key_invalid"
  | "idempotency_key_reused"
  | "idempotency_in_progress"
  | "unsupported_media_type"
  | "internal";

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "Error" });

export const SERVICE_ERROR_STATUS: Readonly<Record<OperationErrorCode, ContentfulStatusCode>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  provider_error: 502,
};

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
) {
  return c.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    status,
  );
}
