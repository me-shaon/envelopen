import { DurableObject } from "cloudflare:workers";
import {
  type BudgetDecision,
  type PlatformLimit,
  type UsageStatus,
  type WorkersPlan,
  welcomeReserve,
} from "@envelopen/core";
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
// - The `unsubscribes` flag says that the UnsubscribeLedger holds unsubscribes that D1
//   rejected (KTD1). It lives here because the send consumer reads `status` before each
//   batch anyway, so the check costs no extra call while the ledger is empty. The
//   ledger sets and clears it with a version, so an older report cannot undo a newer one.
// - Welcome steps report their rows as automation (KTD9, U11). They count in the day's
//   total and in a second count, so the usage view can show the automation share.
// - `reserve` is the check before each welcome step: "defer" when the day's writes are
//   at 70% of the daily limit or more, on Workers Free. The caller passes the plan from
//   the owner's setting, because the Worker cannot read the account's plan. Campaigns,
//   confirmation emails, and unsubscribes do not ask it: they stop only at the limit.

interface LedgerFlag {
  pending: boolean;
  version: number;
}

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

  private async todayAutomation(now: number): Promise<DayCount> {
    const stored = await this.ctx.storage.get<DayCount>("automation");
    const day = utcDay(now);
    return stored?.day === day ? stored : { day, rows: 0 };
  }

  async status(now = Date.now()): Promise<UsageStatus> {
    const [count, automation, limit, ledger] = await Promise.all([
      this.today(now),
      this.todayAutomation(now),
      this.ctx.storage.get<PlatformLimit>("platform_limit"),
      this.ctx.storage.get<LedgerFlag>("unsubscribes"),
    ]);
    return {
      day: count.day,
      rowsWritten: count.rows,
      automationRows: automation.rows,
      dailyLimit: D1_DAILY_WRITE_LIMIT,
      platformLimit: limit ?? null,
      unsubscribesPending: ledger?.pending ?? false,
    };
  }

  /**
   * The UnsubscribeLedger reports whether it holds intents. A report with a version
   * lower than the stored one is ignored. Returns the stored flag.
   */
  async setUnsubscribesPending(pending: boolean, version: number): Promise<boolean> {
    const current = await this.ctx.storage.get<LedgerFlag>("unsubscribes");
    if (current && current.version > version) return current.pending;
    await this.ctx.storage.put("unsubscribes", { pending, version });
    return pending;
  }

  /** Adds the rows that one invocation wrote. */
  async record(rows: number, now = Date.now()): Promise<void> {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const count = await this.today(now);
    await this.ctx.storage.put("rows", { day: count.day, rows: count.rows + rows });
  }

  /** Adds the rows that a welcome step wrote: to the day's total and to the automation count. */
  async recordAutomation(rows: number, now = Date.now()): Promise<void> {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const [count, automation] = await Promise.all([this.today(now), this.todayAutomation(now)]);
    await this.ctx.storage.put({
      rows: { day: count.day, rows: count.rows + rows },
      automation: { day: automation.day, rows: automation.rows + rows },
    });
  }

  /** The reserve check for a welcome step (KTD9). Always "ok" on Workers Paid. */
  async reserve(plan: WorkersPlan, now = Date.now()): Promise<BudgetDecision> {
    const count = await this.today(now);
    return welcomeReserve(plan, count.rows, D1_DAILY_WRITE_LIMIT);
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
