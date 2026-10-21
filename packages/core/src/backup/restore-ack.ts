import type { DbConnection } from "@envelopen/db";
import { OperationError } from "../errors";

// After a restore, campaign sends wait until the owner confirms the age of the backup
// (U5, KTD3). A backup misses the unsubscribes that came after it, so a send to the
// restored lists could reach people who left. The restore sets this flag before its
// first data row. The campaign confirm, the dispatch, and the send consumer check it.

/** `system_settings` key: present while campaign sends wait for the owner after a restore. */
export const RESTORE_ACK_SETTING = "restore_ack_required";

export interface RestoreAck {
  backupId: string;
  backupCreatedAt: number;
  restoredAt: number;
}

/**
 * The restore that still waits for the owner, or null. While it is set, no campaign
 * sends: a backup misses the unsubscribes that came after it (KTD3).
 */
export async function readRestoreAck(db: DbConnection): Promise<RestoreAck | null> {
  const row = await db.db
    .selectFrom("system_settings")
    .select("value")
    .where("key", "=", RESTORE_ACK_SETTING)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<RestoreAck>;
    return {
      backupId: String(parsed.backupId ?? ""),
      backupCreatedAt: Number(parsed.backupCreatedAt ?? 0),
      restoredAt: Number(parsed.restoredAt ?? 0),
    };
  } catch {
    return { backupId: "", backupCreatedAt: 0, restoredAt: 0 };
  }
}

/** Throws a conflict while campaign sends wait for the restore acknowledgement. */
export async function assertNoRestoreHold(db: DbConnection): Promise<void> {
  if (await readRestoreAck(db)) {
    throw new OperationError(
      "conflict",
      "This deployment was restored from a backup. Confirm the age of the backup in Settings before you send.",
      { code: "RESTORE_ACK_REQUIRED" },
    );
  }
}
