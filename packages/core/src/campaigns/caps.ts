import type { DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import type { DailyCounter } from "../connections/daily-cap";
import { SEND_DAY_MS } from "./model";

// Sending days of a connection with a daily cap (U19, R27, R28, KTD14, AE6).
//
// The snapshot puts each batch in a 24-hour window. Window 0 starts when the snapshot
// starts and takes the cap minus the connection's sends of the last 24 hours. Each
// later window takes the full cap. The batches go in seq order, and a batch that does
// not fit goes to the next window. A batch of a later window waits in `pending` with
// `not_before` at the start of its window, so the sweep dispatches it then.
//
// The plan is an estimate. The rolling counter in the RateLimiter Durable Object is the
// limit: the consumer reserves from it before each batch (send-consumer.ts). When the
// counter has no room, the batch waits until the counter frees enough:
// - The room comes back in the same window (the sends of the day before age out): the
//   batch waits, and the plan stays.
// - The room comes back in a later window (a welcome email or a confirmation took part
//   of the window): the window is short. The batch moves to that later window, and the
//   batches after it move with it (`deferForCap`). The end date changes.
// On resume, the plan of the remaining batches starts again from the current window
// with the room that the counter has now (`replanRemaining`).
//
// The current cap of the connection applies to each window that is planned after a
// change. The counter checks the current cap at each send.

export interface SendPlan {
  dailyCap: number;
  /** The messages of the connection in the last 24 hours. */
  usedLast24h: number;
  days: number;
  /** The start of the last sending day. */
  endsAt: number;
}

/** The capacity of each window: window 0 has `first`, every later window has `cap`. */
export interface WindowCapacity {
  first: number;
  cap: number;
}

function capacityOf(window: number, from: number, capacity: WindowCapacity): number {
  return window === from ? Math.max(0, capacity.first) : capacity.cap;
}

export interface PackedBatch {
  seq: number;
  count: number;
}

/**
 * Puts batches in windows in order. It starts at window `from`, which has `used`
 * messages already. A batch larger than a whole window goes alone in a full window: the
 * consumer then stops the campaign with a clear message.
 */
export function packWindows(
  batches: readonly PackedBatch[],
  start: { window: number; used: number },
  capacity: WindowCapacity,
): number[] {
  const windows: number[] = [];
  let window = start.window;
  let used = start.used;
  for (const batch of batches) {
    for (;;) {
      const room = capacityOf(window, start.window, capacity);
      if (used + batch.count <= room) break;
      if (used === 0 && room === capacity.cap) break;
      window++;
      used = 0;
    }
    windows.push(window);
    used += batch.count;
  }
  return windows;
}

/**
 * The sending days of a campaign to `recipients` in batches of `batchSize`: the same
 * packing as the snapshot, with full batches.
 */
export function planSendDays(
  recipients: number,
  capacity: WindowCapacity,
  batchSize: number,
): number {
  if (recipients <= 0) return 1;
  const size = Math.max(1, Math.min(batchSize, capacity.cap));
  const batches: PackedBatch[] = [];
  for (let left = recipients; left > 0; left -= size) {
    batches.push({ seq: batches.length, count: Math.min(size, left) });
  }
  return (packWindows(batches, { window: 0, used: 0 }, capacity).at(-1) ?? 0) + 1;
}

/** The batch size that a capped connection uses: no batch is larger than the cap. */
export function cappedBatchSize(batchSize: number, cap: number | null): number {
  return cap === null ? batchSize : Math.max(1, Math.min(batchSize, cap));
}

/** The plan that prepare and confirm show. Null when the connection has no cap. */
export async function estimateSendPlan(
  counter: Pick<DailyCounter, "used"> | undefined,
  connection: { id: number; daily_cap: number | null } | undefined,
  recipients: number,
  batchSize: number,
  startsAt: number,
): Promise<SendPlan | null> {
  const cap = connection?.daily_cap ?? null;
  if (!connection || cap === null) return null;
  const used = counter ? await counter.used(connection.id).catch(() => 0) : 0;
  const days = planSendDays(
    recipients,
    { first: Math.max(0, cap - used), cap },
    cappedBatchSize(batchSize, cap),
  );
  return { dailyCap: cap, usedLast24h: used, days, endsAt: startsAt + (days - 1) * SEND_DAY_MS };
}

/** The window of a time. */
export function windowOf(anchor: number, time: number): number {
  return Math.max(0, Math.floor((time - anchor) / SEND_DAY_MS));
}

async function campaignCap(db: DbConnection, workspaceId: number, campaignId: number) {
  return db.db
    .selectFrom("campaigns as c")
    .leftJoin("provider_connections as pc", (join) =>
      join.onRef("pc.id", "=", "c.connection_id").on("pc.workspace_id", "=", workspaceId),
    )
    .select([
      "c.send_window_start",
      "c.send_first_capacity",
      "pc.id as connection_id",
      "pc.daily_cap",
    ])
    .where("c.workspace_id", "=", workspaceId)
    .where("c.id", "=", campaignId)
    .executeTakeFirst();
}

/**
 * Fixes window 0 at the start of the snapshot: the time and the room that the counter
 * has. A repeated start keeps the first values. Returns the cap, or null without one.
 */
export async function beginSendWindows(
  db: DbConnection,
  counter: Pick<DailyCounter, "used"> | undefined,
  workspaceId: number,
  campaignId: number,
  now: number,
): Promise<number | null> {
  const state = await campaignCap(db, workspaceId, campaignId);
  const cap = state?.daily_cap ?? null;
  if (!state || cap === null || state.connection_id === null) return null;
  if (state.send_first_capacity !== null) return cap;
  const used = counter ? await counter.used(state.connection_id) : 0;
  await db.db
    .updateTable("campaigns")
    .set({ send_window_start: now, send_first_capacity: Math.max(0, cap - used) })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", campaignId)
    .where("send_first_capacity", "is", null)
    .execute();
  return cap;
}

/** `send_days` from the windows of the batches. */
function sendDaysQuery(db: DbConnection, workspaceId: number, campaignId: number) {
  return sql`
UPDATE campaigns SET send_days = (
  SELECT MAX(send_window) + 1 FROM campaign_batches
  WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId} AND send_window IS NOT NULL
)
WHERE workspace_id = ${workspaceId} AND id = ${campaignId}`.compile(db.db);
}

interface WindowWrite {
  window: number;
  ids: number[];
  notBefore: number | null;
}

/** Groups the packed batches by window, with the `not_before` of each window. */
function windowWrites(
  ids: readonly number[],
  windows: readonly number[],
  notBefore: (window: number) => number | null,
): WindowWrite[] {
  const writes: WindowWrite[] = [];
  ids.forEach((id, index) => {
    const window = windows[index] ?? 0;
    const last = writes.at(-1);
    if (last?.window === window) last.ids.push(id);
    else writes.push({ window, ids: [id], notBefore: notBefore(window) });
  });
  return writes;
}

/**
 * Puts the new batches of a snapshot page in windows, after the batches of the earlier
 * pages. It runs before the page dispatches, so a batch of a later window waits.
 */
export async function assignNewBatches(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  now: number,
): Promise<void> {
  const state = await campaignCap(db, workspaceId, campaignId);
  const cap = state?.daily_cap ?? null;
  const anchor = state?.send_window_start ?? null;
  if (!state || cap === null || anchor === null) return;
  const [last, fresh] = await Promise.all([
    db.db
      .selectFrom("campaign_batches")
      .select((eb) => ["send_window", eb.fn.sum<number>("recipient_count").as("used")])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .where("send_window", "is not", null)
      .groupBy("send_window")
      .orderBy("send_window", "desc")
      .limit(1)
      .executeTakeFirst(),
    db.db
      .selectFrom("campaign_batches")
      .select(["id", "seq", "recipient_count"])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .where("send_window", "is", null)
      .where("status", "=", "pending")
      .orderBy("seq", "asc")
      .execute(),
  ]);
  if (fresh.length === 0) return;
  const current = windowOf(anchor, now);
  const lastWindow = last?.send_window ?? 0;
  const start =
    last && lastWindow >= current
      ? { window: lastWindow, used: Number(last.used ?? 0) }
      : { window: Math.max(current, lastWindow), used: 0 };
  // Window 0 has the room of the start. A later window that the packing starts in has
  // the full cap.
  const first = start.window === 0 ? (state.send_first_capacity ?? cap) : cap;
  const windows = packWindows(
    fresh.map((row) => ({ seq: row.seq, count: row.recipient_count })),
    start,
    { first, cap },
  );
  await writeWindows(
    db,
    workspaceId,
    campaignId,
    windowWrites(
      fresh.map((row) => row.id),
      windows,
      (window) => notBeforeOf(anchor, window, now),
    ),
    ["pending"],
    now,
  );
}

function notBeforeOf(anchor: number, window: number, now: number): number | null {
  const start = anchor + window * SEND_DAY_MS;
  return start > now ? start : null;
}

async function writeWindows(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  writes: readonly WindowWrite[],
  statuses: readonly ("pending" | "enqueued")[],
  now: number,
): Promise<void> {
  await db.atomic([
    ...writes.map((write) =>
      sql`
UPDATE campaign_batches SET send_window = ${write.window}, not_before = ${write.notBefore},
  status = 'pending', updated_at = ${now}
WHERE workspace_id = ${workspaceId} AND campaign_id = ${campaignId}
  AND status IN (${sql.join(statuses)})
  AND id IN (SELECT value FROM json_each(${JSON.stringify(write.ids)}))`.compile(db.db),
    ),
    sendDaysQuery(db, workspaceId, campaignId),
  ]);
}

/**
 * Plans the given batches again from window `from`, which has `first` room. Every later
 * window has the full cap. `firstNotBefore` holds back the batches of window `from`.
 */
async function repack(
  db: DbConnection,
  workspaceId: number,
  campaignId: number,
  rows: readonly { id: number; seq: number; recipient_count: number }[],
  plan: {
    anchor: number;
    from: number;
    first: number;
    cap: number;
    firstNotBefore: number | null;
    statuses: readonly ("pending" | "enqueued")[];
  },
  now: number,
): Promise<void> {
  if (rows.length === 0) return;
  const windows = packWindows(
    rows.map((row) => ({ seq: row.seq, count: row.recipient_count })),
    { window: plan.from, used: 0 },
    { first: plan.first, cap: plan.cap },
  );
  const writes = windowWrites(
    rows.map((row) => row.id),
    windows,
    (window) => {
      const start = notBeforeOf(plan.anchor, window, now);
      if (window !== plan.from || plan.firstNotBefore === null) return start;
      return Math.max(start ?? 0, plan.firstNotBefore);
    },
  );
  await writeWindows(db, workspaceId, campaignId, writes, plan.statuses, now);
}

/**
 * The counter has no room for the batch now: it waits in `pending` until `freeAt`.
 * When that time is in a later window, the window is short, so the batch and every
 * batch of the later windows move (see the comment at the top). Returns false when the
 * batch changed since the pointer (stale).
 */
export async function deferForCap(
  db: DbConnection,
  pointer: { workspaceId: number; campaignId: number; batchId: number; generation: number },
  freeAt: number,
  now: number,
): Promise<boolean> {
  const { workspaceId, campaignId, batchId } = pointer;
  const moved = await db.db
    .updateTable("campaign_batches")
    .set({ status: "pending", not_before: freeAt, updated_at: now })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", batchId)
    .where("generation", "=", pointer.generation)
    .where("status", "=", "enqueued")
    .returning(["seq", "send_window"])
    .executeTakeFirst();
  if (!moved) return false;
  const state = await campaignCap(db, workspaceId, campaignId);
  const anchor = state?.send_window_start ?? null;
  const cap = state?.daily_cap ?? null;
  if (anchor === null || cap === null || moved.send_window === null) return true;
  const target = windowOf(anchor, freeAt);
  if (target <= moved.send_window) return true;
  const rows = await db.db
    .selectFrom("campaign_batches")
    .select(["id", "seq", "recipient_count"])
    .where("workspace_id", "=", workspaceId)
    .where("campaign_id", "=", campaignId)
    .where("status", "=", "pending")
    .where((eb) => eb.or([eb("id", "=", batchId), eb("send_window", ">", moved.send_window)]))
    .orderBy("seq", "asc")
    .execute();
  await repack(
    db,
    workspaceId,
    campaignId,
    rows,
    { anchor, from: target, first: cap, cap, firstNotBefore: freeAt, statuses: ["pending"] },
    now,
  );
  return true;
}

/**
 * Plans the batches that have not sent again, from the current window and the room
 * that the counter has now. Resume calls it, so the end date follows the remaining
 * recipients (for example after a quota pause). Enqueued batches go back to `pending`:
 * resume dispatches the ones that are due.
 */
export async function replanRemaining(
  db: DbConnection,
  counter: Pick<DailyCounter, "used"> | undefined,
  workspaceId: number,
  campaignId: number,
  now: number,
): Promise<void> {
  const state = await campaignCap(db, workspaceId, campaignId);
  const cap = state?.daily_cap ?? null;
  if (!state || cap === null || state.connection_id === null) return;
  let anchor = state.send_window_start;
  if (anchor === null) {
    // The cap came after the start: the plan starts now.
    anchor = now;
    await db.db
      .updateTable("campaigns")
      .set({ send_window_start: now, send_first_capacity: cap })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", campaignId)
      .execute();
  }
  const used = counter ? await counter.used(state.connection_id) : 0;
  const rows = await db.db
    .selectFrom("campaign_batches")
    .select(["id", "seq", "recipient_count"])
    .where("workspace_id", "=", workspaceId)
    .where("campaign_id", "=", campaignId)
    .where("status", "in", ["pending", "enqueued"])
    .orderBy("seq", "asc")
    .execute();
  await repack(
    db,
    workspaceId,
    campaignId,
    rows,
    {
      anchor,
      from: windowOf(anchor, now),
      first: Math.max(0, cap - used),
      cap,
      firstNotBefore: null,
      statuses: ["pending", "enqueued"],
    },
    now,
  );
}
