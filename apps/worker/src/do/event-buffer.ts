import { DurableObject } from "cloudflare:workers";
import {
  type BufferedEvent,
  bufferKey,
  FLUSH_DELAY_MS,
  FLUSH_SIZE,
  type FlushResult,
  flushEvents,
  isBufferedEvent,
} from "@envelopen/core";
import { createDb, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { markBursts } from "../tracking/classify";
import { usageMeter, usageSink } from "./usage";

// The EventBuffer (KTD31): one instance per workspace, with its events in Durable Object
// SQLite storage. Tracking hits and webhooks add events and return at once. The buffer
// writes them to D1 in groups:
//
// - at 200 events, during the `add` call that reaches the count;
// - otherwise by the alarm, 30 seconds after the first waiting event.
//
// One flush writes at most 200 events in fewer than 50 D1 statements (events/flush.ts).
// Flushes run one at a time. The events of a group leave storage only after D1 has
// committed them. A failed flush keeps them and tries again from the alarm: after a
// D1 daily-limit error, at 00:00 UTC (KTD24).
//
// The flush reports its D1 writes to the UsageMeter, as every other invocation does.
//
// Each group gets an id before the D1 write, and storage keeps the id with the last
// sequence number of the group. If the Durable Object stops after the D1 commit but
// before the local delete, the next flush sends the same group with the same id, and
// the flush skips it (events/flush.ts). So no event counts twice.

/** Retry delay after a flush error that is not the daily limit. */
const RETRY_MS = 60_000;
/**
 * The most events that wait. Beyond it, new tracking events are dropped, so a long D1
 * outage cannot fill the storage. Provider events are still accepted: their rows are in
 * D1 already, and the cron hands them over again (events/retention.ts).
 */
export const MAX_WAITING = 20_000;

/** The storage key of the group that is being written: its flush id and last sequence number. */
export const PENDING_FLUSH_KEY = "pendingFlush";

export interface PendingFlush {
  id: string;
  last: number;
}

export interface AddResult {
  waiting: number;
  flushed: FlushResult | null;
}

export class EventBuffer extends DurableObject<Env> {
  private running: Promise<FlushResult | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  key TEXT UNIQUE,
  body TEXT NOT NULL
)`);
    });
  }

  /** The delay of a partial flush. End-to-end tests shorten it (EVENT_FLUSH_DELAY_MS). */
  private flushDelay(): number {
    const value = Number(this.env.EVENT_FLUSH_DELAY_MS);
    return Number.isFinite(value) && value >= 100 && value <= FLUSH_DELAY_MS
      ? value
      : FLUSH_DELAY_MS;
  }

  private waiting(): number {
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one();
    return row.n;
  }

  /**
   * Stores the events. Flushes at once when 200 or more wait, or sets the alarm.
   * `now` is the time the flush records. The alarm always follows the real clock.
   */
  async add(workspaceId: number, events: unknown[], now = Date.now()): Promise<AddResult> {
    await this.ctx.storage.put("workspace", workspaceId);
    let waiting = this.waiting();
    for (const event of events) {
      if (!isBufferedEvent(event)) continue;
      if (waiting >= MAX_WAITING && event.source === "tracking") continue;
      const cursor = this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO events (key, body) VALUES (?, ?)",
        bufferKey(event),
        JSON.stringify(event),
      );
      waiting += cursor.rowsWritten > 0 ? 1 : 0;
    }
    if (waiting >= FLUSH_SIZE) {
      const flushed = await this.flush(now);
      return { waiting: this.waiting(), flushed };
    }
    if (waiting > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.flushDelay());
    }
    return { waiting, flushed: null };
  }

  /** Writes one group of up to 200 events. Concurrent calls share one flush. */
  async flush(now = Date.now()): Promise<FlushResult | null> {
    if (!this.running) {
      this.running = this.flushGroup(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async alarm(): Promise<void> {
    // Errors are caught here and the alarm is set again, so a long outage does not
    // run out of the platform's alarm retries.
    await this.flush(Date.now());
  }

  /** The number of waiting events. For tests and diagnostics. */
  async size(): Promise<number> {
    return this.waiting();
  }

  private async flushGroup(now: number): Promise<FlushResult | null> {
    const workspaceId = await this.ctx.storage.get<number>("workspace");
    const select = (pending: PendingFlush | undefined) =>
      pending
        ? this.ctx.storage.sql
            .exec<{ seq: number; body: string }>(
              "SELECT seq, body FROM events WHERE seq <= ? ORDER BY seq",
              pending.last,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<{ seq: number; body: string }>(
              "SELECT seq, body FROM events ORDER BY seq LIMIT ?",
              FLUSH_SIZE,
            )
            .toArray();
    // A group from an earlier flush that did not finish goes first, with the same id.
    let pending = await this.ctx.storage.get<PendingFlush>(PENDING_FLUSH_KEY);
    let rows = select(pending);
    if (pending && rows.length === 0) {
      await this.ctx.storage.delete(PENDING_FLUSH_KEY);
      pending = undefined;
      rows = select(undefined);
    }
    if (rows.length === 0 || workspaceId === undefined) return null;
    if (!pending) {
      pending = { id: crypto.randomUUID(), last: rows.at(-1)?.seq ?? 0 };
      await this.ctx.storage.put(PENDING_FLUSH_KEY, pending);
    }
    const events: BufferedEvent[] = [];
    for (const row of rows) {
      try {
        const event: unknown = JSON.parse(row.body);
        if (isBufferedEvent(event)) events.push(event);
      } catch {
        // A row that does not parse is dropped with its group.
      }
    }
    const last = pending.last;
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    let result: FlushResult;
    try {
      result = await flushEvents(db, workspaceId, markBursts(events), now, {
        flushId: pending.id,
      });
    } catch (error) {
      if (isD1DailyLimitError(error)) {
        const until = nextUtcMidnight(now);
        await usageMeter(this.env)
          .setPlatformLimit(now, until)
          .catch(() => undefined);
        await this.ctx.storage.setAlarm(Math.max(until, Date.now()) + 60_000);
      } else {
        console.error("EventBuffer flush failed", error);
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      }
      return null;
    } finally {
      await db.meter.flush().catch((error) => console.error("Usage report failed", error));
    }
    this.ctx.storage.sql.exec("DELETE FROM events WHERE seq <= ?", last);
    await this.ctx.storage.delete(PENDING_FLUSH_KEY);
    const left = this.waiting();
    // A full buffer drains one group per second. A partial one waits for the delay.
    if (left > 0)
      await this.ctx.storage.setAlarm(Date.now() + (left >= FLUSH_SIZE ? 1000 : this.flushDelay()));
    else await this.ctx.storage.deleteAlarm();
    return result;
  }
}
