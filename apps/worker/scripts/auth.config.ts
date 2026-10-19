// Configuration for the Better Auth CLI only. It generates the SQL for the auth tables
// (KTD3). From the repository root:
//
//   npx auth@1.7.11 generate --config apps/worker/scripts/auth.config.ts --output auth.sql --yes
//
// The CLI compares the configuration with the database that it gets. This config gives
// it an empty in-memory SQLite database, so the output creates every auth table. Copy
// the output into a new migration in packages/db/migrations. The Worker never imports
// this file. It builds its own instance per request in src/auth/better-auth.ts.
import { DatabaseSync } from "node:sqlite";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { authSchemaOptions, passkeySchemaOptions } from "../src/auth/schema-options";

export const auth = betterAuth({
  baseURL: "http://localhost",
  database: new DatabaseSync(":memory:"),
  ...authSchemaOptions,
  emailAndPassword: { enabled: true },
  plugins: [passkey({ schema: passkeySchemaOptions })],
});
