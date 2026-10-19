import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  addExclusions,
  beginSnapshot,
  type CampaignJob,
  emptyExclusions,
  finishSnapshot,
  type PageOutcome,
  type SnapshotStart,
  snapshotPage,
  systemAudit,
  transitionCampaign,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { usageMeter, usageSink } from "../do/usage";
import { sendQueue } from "../services";

// The campaign snapshot Workflow (U9, KTD22). One instance takes the recipient
// snapshot of one campaign start, page by page, and dispatches the batches of each
// page as it goes (packages/core/src/campaigns/snapshot.ts).
//
// Free-plan budget per step: one page of SNAPSHOT_PAGE_CONTACTS contacts is about
// 8 D1 queries, set-based, and one queue call. The Worker CPU per step is small. 1,000
// pages fit the limit of 1,024 steps per instance, so one start covers 1,000,000 contacts.
//
// On the D1 daily limit, a step sets the platform_limit flag and the run sleeps until
// after 00:00 UTC, then takes the same page again. Any page is safe to repeat.

const STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;
/** Wait a little past 00:00 UTC before the run tries D1 again. */
const RESET_MARGIN_MS = 5 * 60 * 1000;
export const SNAPSHOT_MAX_PAGES = 1_000;

type Guarded<T> = { kind: "ok"; value: T } | { kind: "limit"; resumeAt: number };

export class CampaignWorkflow extends WorkflowEntrypoint<Env, CampaignJob> {
  /** Runs one step's work on a fresh metered connection, and reports its writes. */
  private async guarded<T>(work: (db: DbConnection) => Promise<T>): Promise<Guarded<T>> {
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    try {
      return { kind: "ok", value: await work(db) };
    } catch (error) {
      if (!isD1DailyLimitError(error)) throw error;
      const now = Date.now();
      await usageMeter(this.env).setPlatformLimit(now, nextUtcMidnight(now));
      return { kind: "limit", resumeAt: nextUtcMidnight(now) + RESET_MARGIN_MS };
    } finally {
      await db.meter.flush().catch((error) => console.error("Usage report failed", error));
    }
  }

  /** A step that sleeps over the daily limit and tries again. */
  private async step<T>(
    step: WorkflowStep,
    name: string,
    work: (db: DbConnection) => Promise<T>,
  ): Promise<T> {
    for (let pause = 0; ; pause++) {
      const label = pause === 0 ? name : `${name} (after pause ${pause})`;
      // The step results are plain JSON objects, so the cast only drops the Serializable wrapper.
      const outcome = (await step.do(
        label,
        STEP,
        () => this.guarded(work) as Promise<never>,
      )) as Guarded<T>;
      if (outcome.kind === "ok") return outcome.value;
      await step.sleepUntil(`wait for the D1 reset ${pause + 1}: ${name}`, outcome.resumeAt);
    }
  }

  async run(event: WorkflowEvent<CampaignJob>, step: WorkflowStep): Promise<string> {
    const job = event.payload;
    const queue = sendQueue(this.env);
    const start = (await this.step(step, "begin", (db) => beginSnapshot(db, job))) as SnapshotStart;
    if (start.state === "stop") return start.reason;

    let afterId = 0;
    let excluded = emptyExclusions();
    for (let index = 0; index < SNAPSHOT_MAX_PAGES; index++) {
      const page = (await this.step(step, `page ${index}`, (db) =>
        snapshotPage(
          db,
          queue,
          job,
          { afterId, cut: start.cut, batchSize: start.batchSize },
          Date.now(),
        ),
      )) as PageOutcome;
      if (page.kind === "stop") return page.reason;
      excluded = addExclusions(excluded, page.excluded);
      afterId = page.nextAfterId;
      if (page.done) {
        const total = excluded;
        const result = await this.step(step, "finish", async (db) => {
          const finished = await finishSnapshot(db, job, total, Date.now());
          if (finished.changed && finished.status) {
            await systemAudit(db, job.workspaceId, job.campaignId, `campaigns.${finished.status}`, {
              by: "snapshot",
            });
          }
          return finished;
        });
        return result.status ?? "snapshot done";
      }
    }
    await this.step(step, "too many pages", (db) =>
      transitionCampaign(db, job.workspaceId, job.campaignId, ["sending"], "paused", Date.now(), {
        pause_reason: "manual",
        pause_detail:
          "The audience is larger than one campaign can take. Split it into several campaigns.",
        paused_at: Date.now(),
      }),
    );
    return "too many pages";
  }
}
