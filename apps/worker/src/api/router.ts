import {
  registry as defaultRegistry,
  isOperationError,
  type Operation,
  pathParameters,
  type Registry,
  runOperation,
  type Services,
} from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Handler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createServices } from "../services";
import { noSessionResolver, principalMiddleware, type SessionResolver } from "./auth";
import type { ApiEnv } from "./context";
import { ErrorSchema, errorJson, SERVICE_ERROR_STATUS } from "./errors";
import { IDEMPOTENCY_HEADER, idempotency } from "./idempotency";
import { type AppOriginResolver, originCheck, requestOrigin } from "./origin-check";
import {
  apiKeyRateLimit,
  createFixedWindowLimiter,
  DEFAULT_API_KEY_RATE_LIMIT,
  type RateLimiter,
} from "./rate-limit";

export interface ApiRouterOptions {
  /** Defaults to the full registry from `@envelopen/core`. Tests pass their own. */
  registry?: Registry;
  /** Defaults to "no session". The Worker entry passes the Better Auth resolver. */
  resolveSession?: SessionResolver;
  rateLimiter?: RateLimiter;
  appOrigin?: AppOriginResolver;
  /** Defaults to `createDb(env)`. Tests turn on the workspace-scope check here. */
  createDb?: (env: Env) => DbConnection;
  /** Defaults to the Worker's bindings: R2, the import Workflow, and SIGNING_KEY. */
  createServices?: (env: Env) => Partial<Services>;
}

/** The fixed part of the OpenAPI document. The paths come from the registry. */
export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "Envelopen API",
    version: "1.0.0",
    description:
      "Every operation of the Envelopen admin app. Send an API key as `Authorization: Bearer evk_...`. " +
      "Lists use cursor pagination. POST requests accept an `Idempotency-Key` header. " +
      "A browser session picks its workspace with the `X-Envelopen-Workspace` header.",
  },
  servers: [{ url: "/api" }],
};

const BODY_METHODS = new Set(["post", "put", "patch"]);

function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}

/** Builds the `@hono/zod-openapi` route for one registry entry. */
export function routeFor(operation: Operation): RouteConfig {
  const pathNames = pathParameters(operation.path);
  // The input schema is erased to `ZodObject` here, so the mask is typed loosely.
  const inPath = Object.fromEntries(pathNames.map((name) => [name, true])) as Record<string, true> &
    Record<number, never>;
  const rest = operation.input.omit(inPath);
  const hasRest = Object.keys(rest.shape).length > 0;

  const request: NonNullable<RouteConfig["request"]> = {};
  if (pathNames.length > 0) request.params = operation.input.pick(inPath);
  if (hasRest && BODY_METHODS.has(operation.method)) {
    request.body = {
      content: { "application/json": { schema: rest } },
      required: !rest.safeParse({}).success,
    };
  } else if (hasRest) {
    request.query = rest;
  }

  const successStatus = operation.successStatus ?? 200;
  // A response with a secret is never stored for replay, so its route ignores the key.
  const idempotent = operation.method === "post" && !operation.sensitiveOutput;
  return {
    method: operation.method,
    path: operation.path,
    operationId: operation.id,
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    tags: [operation.id.split(".")[0] as string],
    security: [{ bearerAuth: [] }],
    "x-envelopen-scope": operation.scope,
    "x-envelopen-risk": operation.risk,
    "x-envelopen-mcp": operation.mcp.class,
    request,
    ...(idempotent ? { middleware: [idempotency(operation.path)] } : {}),
    responses: {
      [successStatus]: {
        description: "Success",
        content: { "application/json": { schema: operation.output } },
      },
      400: errorResponse("The input is not valid."),
      401: errorResponse("No valid session or API key."),
      403: errorResponse("The principal lacks the scope, or a session request is cross-origin."),
      404: errorResponse("Not found."),
      ...(idempotent
        ? {
            409: errorResponse("A request with the same Idempotency-Key is still running."),
            422: errorResponse("The Idempotency-Key was used with a different body."),
          }
        : {}),
      429: errorResponse("Rate limit reached."),
    },
  } as RouteConfig;
}

/** Runs the operation through the service layer. The transport never checks scopes. */
function handlerFor(operation: Operation): Handler<ApiEnv> {
  return async (c) => {
    // The validators stored each part of the request. Unused parts are undefined.
    const valid = (target: string) =>
      (c.req as unknown as { valid(target: string): Record<string, unknown> | undefined }).valid(
        target,
      ) ?? {};
    const input = { ...valid("query"), ...valid("json"), ...valid("param") };
    const output = await runOperation(c.var.principal, operation, input, {
      db: c.var.db,
      services: c.var.services,
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    return c.json(output as object, operation.successStatus ?? 200);
  };
}

/**
 * Creates the `/api` router from the registry (R66). Mount it with `app.route("/api", ...)`.
 *
 * Order for every request: database connection, principal (401), origin check for
 * session writes (403), API-key rate limit (429), idempotency for POST, input
 * validation (400), and then the service layer, which checks the scope (403).
 */
export function createApiRouter(options: ApiRouterOptions = {}): OpenAPIHono<ApiEnv> {
  const registry = options.registry ?? defaultRegistry;
  const rateLimiter = options.rateLimiter ?? createFixedWindowLimiter(DEFAULT_API_KEY_RATE_LIMIT);
  const connect = options.createDb ?? ((env: Env) => createDb(env));
  const services = options.createServices ?? createServices;

  const api = new OpenAPIHono<ApiEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return errorJson(c, 400, "invalid_input", "The input is not valid.", result.error.issues);
      }
    },
  });

  api.onError((error, c) => {
    if (isOperationError(error)) {
      return errorJson(
        c,
        SERVICE_ERROR_STATUS[error.code],
        error.code,
        error.message,
        error.details,
      );
    }
    if (error instanceof HTTPException) {
      const status = error.status as ContentfulStatusCode;
      const code = status === 415 ? "unsupported_media_type" : "invalid_input";
      return errorJson(c, status, code, error.message || "The request is not valid.");
    }
    console.error("Unhandled API error", error);
    return errorJson(c, 500, "internal", "Something went wrong.");
  });

  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: `An Envelopen API key. The browser app uses its session cookie instead. Send \`${IDEMPOTENCY_HEADER}\` on POST to make retries safe.`,
  });

  // Public: registered before the auth middleware, so Hono answers it first.
  api.doc31("/openapi.json", OPENAPI_CONFIG);

  api.use("*", async (c, next) => {
    c.set("db", connect(c.env));
    c.set("services", services(c.env));
    await next();
  });
  api.use("*", principalMiddleware(options.resolveSession ?? noSessionResolver));
  api.use("*", originCheck(options.appOrigin ?? requestOrigin));
  api.use("*", apiKeyRateLimit(rateLimiter));

  for (const operation of registry.operations) {
    // The route config is built at run time from the registry, so its literal types
    // are not known here. The handler reads the validated input itself.
    api.openapi(routeFor(operation), handlerFor(operation) as never);
  }

  api.all("*", (c) => errorJson(c, 404, "not_found", "No API route matches this request."));
  return api;
}

/** The OpenAPI document of a registry, without a running Worker. */
export function buildOpenApiDocument(registry: Registry = defaultRegistry) {
  return createApiRouter({ registry }).getOpenAPI31Document(OPENAPI_CONFIG);
}
