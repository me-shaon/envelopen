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
          // RESTORE_DB is a second, fresh deployment for the restore tests (U5).
          d1Databases: ["DB", "RESTORE_DB"],
          // Imports and exports keep their files in R2.
          r2Buckets: ["BUCKET"],
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
