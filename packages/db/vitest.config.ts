import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Read the same migrations that `wrangler d1 migrations apply` runs. The URL form
  // avoids a dependency on Node.js types in this package.
  const migrationsDir = decodeURIComponent(new URL("./migrations", import.meta.url).pathname);
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        // The data tests need only a D1 binding, so they do not load the root Wrangler config.
        miniflare: {
          compatibilityDate: "2026-10-01",
          d1Databases: ["DB"],
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
