import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files can run more than once. applyD1Migrations() applies only the
// migrations that are not applied yet, so this is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.RESTORE_DB, env.TEST_MIGRATIONS);
