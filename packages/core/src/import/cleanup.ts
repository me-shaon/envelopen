import { type DbConnection, unscoped } from "@envelopen/db";
import { errorPartPrefix } from "./process";

// The cron deletes files that hold contact data when they expire: uploads that never
// became an import, error files 24 hours after the import, and exports after 24 hours
// (R18). It works across workspaces, so its queries are deliberately unscoped (KTD4).
// Each run handles a bounded number of rows, so it stays inside the Free-plan limits.

// About 25 D1 queries per run with the idempotency purge, under the 50 of Workers Free.
const BATCH = 10;

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  const listed = await bucket.list({ prefix, limit: 1000 });
  const keys = listed.objects.map((object) => object.key);
  if (keys.length > 0) await bucket.delete(keys);
}

export async function cleanupExpiredFiles(
  conn: DbConnection,
  bucket: R2Bucket,
  now: number = Date.now(),
): Promise<{ imports: number; exports: number }> {
  const db = unscoped(conn.db);
  const imports = await db
    .selectFrom("imports")
    .select(["id", "workspace_id", "status", "file_key", "error_file_key"])
    .where("expires_at", "<=", now)
    .where((eb) => eb.or([eb("file_key", "is not", null), eb("error_file_key", "is not", null)]))
    .limit(BATCH)
    .execute();
  for (const row of imports) {
    const keys = [row.file_key, row.error_file_key].filter((key): key is string => key !== null);
    await bucket.delete(keys);
    await deletePrefix(bucket, errorPartPrefix(row.workspace_id, row.id));
    const ended = row.status === "completed" || row.status === "failed";
    await conn.db
      .updateTable("imports")
      .set({
        file_key: null,
        error_file_key: null,
        updated_at: now,
        ...(ended
          ? {}
          : row.status === "importing"
            ? { status: "failed" as const, failure: "The import did not finish in time." }
            : { status: "expired" as const }),
      })
      .where("workspace_id", "=", row.workspace_id)
      .where("id", "=", row.id)
      .execute();
  }

  const exports = await db
    .selectFrom("exports")
    .select(["id", "workspace_id", "file_key"])
    .where("expires_at", "<=", now)
    .where("file_key", "is not", null)
    .limit(BATCH)
    .execute();
  for (const row of exports) {
    if (row.file_key) await bucket.delete(row.file_key);
    await conn.db
      .updateTable("exports")
      .set({ file_key: null, status: "expired" })
      .where("workspace_id", "=", row.workspace_id)
      .where("id", "=", row.id)
      .execute();
  }
  return { imports: imports.length, exports: exports.length };
}
