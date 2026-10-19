// Typed client for the public REST API (R56, R66).
//
// The types come from the OpenAPI document that the Worker generates from the
// operation registry: `pnpm openapi` writes `openapi.json` and `schema.d.ts` here.
// The UI imports nothing from the Worker or `@envelopen/core`, so it can only call
// the same public API that API keys use. openapi-fetch is a thin typed wrapper around
// `fetch` (about 6 kB), and the generated file is types only.
import createClient from "openapi-fetch";
import type { components, operations, paths } from "./schema";

export type { components, operations, paths };
export type ApiError = components["schemas"]["Error"];

/**
 * The browser sends the session cookie on these same-origin requests, and it adds
 * the `Origin` header to POST requests, which the Worker checks (KTD8).
 */
export const api = createClient<paths>({ baseUrl: "/api", credentials: "same-origin" });
