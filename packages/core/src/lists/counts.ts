import { type DbConnection, unscoped } from "@envelopen/db";
import { sql } from "kysely";

// The recount of the stored member counts (migration 0014). Triggers keep
// lists.subscribed_count, lists.unsubscribed_count, and tags.contact_count in the
// statement that changes a membership, so the counts do not drift. This job is the
// repair path for a change that bypassed the triggers, for example a manual SQL fix or
// a restore of part of a table.
//
// Each statement recounts at most COUNT_CHUNK lists or tags of one workspace, so it reads
// the memberships of those lists only (through the list and tag indexes). It writes only
// a row whose count is wrong, so a run over correct counts writes nothing.

/** Lists or tags that one statement recounts. */
export const COUNT_CHUNK = 50;

export interface CountRepair {
  lists: number;
  tags: number;
}

async function chunkIds(
  db: DbConnection,
  table: "lists" | "tags",
  workspaceId: number,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db.db
    .selectFrom(table)
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", ">", afterId)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => row.id);
}

/** Recounts the lists and tags of one workspace. Returns how many rows it corrected. */
export async function repairCounts(
  db: DbConnection,
  workspaceId: number,
  chunk = COUNT_CHUNK,
): Promise<CountRepair> {
  const repair: CountRepair = { lists: 0, tags: 0 };
  for (let afterId = 0; ; ) {
    const ids = await chunkIds(db, "lists", workspaceId, afterId, chunk);
    if (ids.length === 0) break;
    const result = await sql`UPDATE lists SET subscribed_count = v.s, unsubscribed_count = v.u
FROM (
  SELECT l.id,
    (SELECT count(*) FROM list_members m WHERE m.list_id = l.id AND m.workspace_id = ${workspaceId} AND m.status = 'subscribed') AS s,
    (SELECT count(*) FROM list_members m WHERE m.list_id = l.id AND m.workspace_id = ${workspaceId} AND m.status = 'unsubscribed') AS u
  FROM lists l
  WHERE l.workspace_id = ${workspaceId} AND l.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
) AS v
WHERE lists.workspace_id = ${workspaceId} AND lists.id = v.id
  AND (lists.subscribed_count <> v.s OR lists.unsubscribed_count <> v.u)`.execute(db.db);
    repair.lists += Number(result.numAffectedRows ?? 0);
    afterId = ids.at(-1) as number;
  }
  for (let afterId = 0; ; ) {
    const ids = await chunkIds(db, "tags", workspaceId, afterId, chunk);
    if (ids.length === 0) break;
    const result = await sql`UPDATE tags SET contact_count = v.n
FROM (
  SELECT t.id,
    (SELECT count(*) FROM contact_tags ct WHERE ct.tag_id = t.id AND ct.workspace_id = ${workspaceId}) AS n
  FROM tags t
  WHERE t.workspace_id = ${workspaceId} AND t.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
) AS v
WHERE tags.workspace_id = ${workspaceId} AND tags.id = v.id AND tags.contact_count <> v.n`.execute(
      db.db,
    );
    repair.tags += Number(result.numAffectedRows ?? 0);
    afterId = ids.at(-1) as number;
  }
  return repair;
}

/**
 * The daily cron job: recounts every workspace. A corrected row means that a change
 * bypassed the triggers, so the job logs it.
 */
export async function repairAllCounts(db: DbConnection): Promise<CountRepair> {
  // The one deliberate cross-workspace read: the list of workspaces (KTD4).
  const workspaces = await unscoped(db.db).selectFrom("workspaces").select("id").execute();
  const total: CountRepair = { lists: 0, tags: 0 };
  for (const { id } of workspaces) {
    const repair = await repairCounts(db, id);
    if (repair.lists > 0 || repair.tags > 0) {
      console.warn(
        `Recount corrected ${repair.lists} lists and ${repair.tags} tags of workspace ${id}.`,
      );
    }
    total.lists += repair.lists;
    total.tags += repair.tags;
  }
  return total;
}
