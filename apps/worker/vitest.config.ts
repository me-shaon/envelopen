import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The API tests need the schema, so apply the same migrations as the deploy.
  const migrationsDir = decodeURIComponent(
    new URL("../../packages/db/migrations", import.meta.url).pathname,
  );
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "../../wrangler.jsonc" },
        miniflare: {
          // Test-only bindings. The setup file applies the migrations. The import Workflow
          // reads SIGNING_KEY from its own env, so the tests set a fixed key here.
          bindings: {
            TEST_MIGRATIONS: migrations,
            SIGNING_KEY: btoa(String.fromCharCode(...new Array(32).fill(9))),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
