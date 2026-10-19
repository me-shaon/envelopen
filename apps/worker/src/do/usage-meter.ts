import { DurableObject } from "cloudflare:workers";
import type { PlatformLimit, UsageStatus } from "@envelopen/core";
import { D1_DAILY_WRITE_LIMIT } from "./usage";

// The daily D1 budget on Workers Free (KTD24, R71). One instance for the deployment,
// because the D1 limit is per account.
//
// - Each invocation reports the rows that its metered binding wrote (`record`). The
//   count resets at 00:00 UTC. The usage view (U11) reads it and warns at 80%.
// - The first D1 daily-limit error sets the `platform_limit` flag with the reset time.
//   It lives here, not in D1, because D1 rejects writes at that point. The consumer
//   reads it before each claim and drops the message without a write. The campaign
//   view reads it to show the pause. After 00:00 UTC the cron resumes the campaigns
//   and clears the flag.

interface DayCount {
  day: string;
  rows: number;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class UsageMeter extends DurableObject<Env> {
  private async today(now: number): Promise<DayCount> {
    const stored = await this.ctx.storage.get<DayCount>("rows");
    const day = utcDay(now);
    return stored?.day === day ? stored : { day, rows: 0 };
  }

  async status(now = Date.now()): Promise<UsageStatus> {
    const [count, limit] = await Promise.all([
      this.today(now),
      this.ctx.storage.get<PlatformLimit>("platform_limit"),
    ]);
    return {
      day: count.day,
      rowsWritten: count.rows,
      dailyLimit: D1_DAILY_WRITE_LIMIT,
      platformLimit: limit ?? null,
    };
  }

  /** Adds the rows that one invocation wrote. */
  async record(rows: number, now = Date.now()): Promise<void> {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const count = await this.today(now);
    await this.ctx.storage.put("rows", { day: count.day, rows: count.rows + rows });
  }

  /** Sets the flag. A second report keeps the first time and the later reset. */
  async setPlatformLimit(since: number, until: number): Promise<PlatformLimit> {
    const current = await this.ctx.storage.get<PlatformLimit>("platform_limit");
    const next = current
      ? { since: Math.min(current.since, since), until: Math.max(current.until, until) }
      : { since, until };
    await this.ctx.storage.put("platform_limit", next);
    return next;
  }

  async clearPlatformLimit(): Promise<void> {
    await this.ctx.storage.delete("platform_limit");
  }
}
