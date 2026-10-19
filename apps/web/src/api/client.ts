// Typed client for the public REST API (R56, R66).
//
// The types come from the OpenAPI document that the Worker generates from the
// operation registry: `pnpm openapi` writes `openapi.json` and `schema.d.ts` here.
// The UI imports nothing from the Worker or `@envelopen/core`, so it can only call
// the same public API that API keys use. openapi-fetch is a thin typed wrapper around
// `fetch` (about 6 kB), and the generated file is types only.
import createClient from "openapi-fetch";
import type { components, operations, paths } from "./schema";
import { getWorkspaceId, WORKSPACE_HEADER } from "./workspace";

export type { components, operations, paths };
export type ApiError = components["schemas"]["Error"];
export type Schemas = components["schemas"];

/**
 * The browser sends the session cookie on these same-origin requests, and it adds
 * the `Origin` header to POST requests, which the Worker checks (KTD8).
 */
export const api = createClient<paths>({ baseUrl: "/api", credentials: "same-origin" });

api.use({
  onRequest({ request, schemaPath }) {
    // The workspace list feeds the switcher, so it must work even when the stored
    // workspace was archived. It lists every workspace of the owner anyway.
    const id = getWorkspaceId();
    if (id === null || (schemaPath === "/workspaces" && request.method === "GET")) return;
    request.headers.set(WORKSPACE_HEADER, String(id));
    return request;
  },
});

/** A failed API call, with the status and the error code from the response. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Returns the data of an openapi-fetch result, or throws an ApiRequestError. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (error !== undefined || data === undefined) {
    const body = (error as Partial<ApiError> | undefined)?.error;
    throw new ApiRequestError(
      response.status,
      body?.code ?? "unknown",
      body?.message ?? "The request failed. Try again.",
    );
  }
  return data;
}
