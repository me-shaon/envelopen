// Writes the OpenAPI document of the registry to apps/web/src/api/openapi.json.
// `pnpm openapi` runs this script and then openapi-typescript, which writes the
// client types to apps/web/src/api/schema.d.ts. The router test fails when the
// committed document is out of date.
import { writeFileSync } from "node:fs";
import { register } from "node:module";

// The router imports the Worker services, and they import `cloudflare:sockets`, which
// Node cannot load. This hook gives Node an empty stand-in. The document does not use it.
const stub = "export function connect() { throw new Error('No sockets in Node.'); }";
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:sockets") {
    return { url: "data:text/javascript,${encodeURIComponent(stub)}", shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const { buildOpenApiDocument } = await import("../src/api/router");
const target = new URL("../../web/src/api/openapi.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
