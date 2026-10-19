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
          // Test-only binding. The setup file applies these migrations.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
