import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The service tests run on D1 with the same migrations as the deploy.
  const migrationsDir = decodeURIComponent(new URL("../db/migrations", import.meta.url).pathname);
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
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
