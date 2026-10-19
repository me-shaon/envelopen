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

/** Retry delay after a flush error that is not the daily limit. */
const RETRY_MS = 60_000;
/**
 * The most events that wait. Beyond it, new tracking events are dropped, so a long D1
 * outage cannot fill the storage. Provider events are still accepted: their rows are in
 * D1 already, and the cron hands them over again (events/retention.ts).
 */
export const MAX_WAITING = 20_000;

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
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
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
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; body: string }>(
        "SELECT seq, body FROM events ORDER BY seq LIMIT ?",
        FLUSH_SIZE,
      )
      .toArray();
    if (rows.length === 0 || workspaceId === undefined) return null;
    const events: BufferedEvent[] = [];
    for (const row of rows) {
      try {
        const event: unknown = JSON.parse(row.body);
        if (isBufferedEvent(event)) events.push(event);
      } catch {
        // A row that does not parse is dropped with its group.
      }
    }
    const last = rows.at(-1)?.seq ?? 0;
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    let result: FlushResult;
    try {
      result = await flushEvents(db, workspaceId, markBursts(events), now);
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
    const left = this.waiting();
    // A full buffer drains one group per second. A partial one waits for the delay.
    if (left > 0)
      await this.ctx.storage.setAlarm(Date.now() + (left >= FLUSH_SIZE ? 1000 : FLUSH_DELAY_MS));
    else await this.ctx.storage.deleteAlarm();
    return result;
  }
}
