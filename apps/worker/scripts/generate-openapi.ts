// Writes the OpenAPI document of the registry to apps/web/src/api/openapi.json.
// `pnpm openapi` runs this script and then openapi-typescript, which writes the
// client types to apps/web/src/api/schema.d.ts. The router test fails when the
// committed document is out of date.
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../src/api/router";

const target = new URL("../../web/src/api/openapi.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
