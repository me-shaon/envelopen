import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type BackupDeps,
  type BackupJob,
  type BackupRunner,
  backupSteps,
  driveBackup,
  failBackup,
} from "@envelopen/core";
import { createDb, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { usageMeter, usageSink } from "../do/usage";
import { createServices } from "../services";

// The backup Workflow (U4, KTD2). One instance runs one backup run: the start, one step
// per chunk of about 1,000 rows, and the manifest (packages/core/src/backup/run.ts).
//
// - The run reads D1 within a daily read budget over all runs (BACKUP_READ_BUDGET).
//   When the budget is spent, the run sleeps until after 00:00 UTC and goes on.
// - On the D1 daily limit, a step sets the platform_limit flag, sleeps until after
//   00:00 UTC, and tries the same step again, as the campaign Workflow does.
// - Another error is retried three times, then the run is marked failed.
//
// Free-plan budget per step: one D1 read of at most 1,000 rows, one AES-GCM pass over
// the chunk, one R2 put, an optional S3 put, and one row written. The data key passes
// between steps sealed with ENCRYPTION_KEY, so the Workflow state never holds it in
// plain form.

const STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;
/** Wait a little past 00:00 UTC before the run tries D1 again. */
const RESET_MARGIN_MS = 5 * 60 * 1000;

type Guarded<T> = { kind: "ok"; value: T } | { kind: "limit"; resumeAt: number };

/** Thrown inside a step on the D1 daily limit. The runner turns it into a sleep. */
class D1LimitPause extends Error {
  constructor(readonly resumeAt: number) {
    super("The D1 daily limit is reached.");
  }
}

export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupJob> {
  /**
   * Runs one step's work on a fresh metered connection, and reports its writes. On the
   * D1 daily limit, it sets the platform_limit flag and throws D1LimitPause.
   */
  private async withDeps<T>(work: (deps: BackupDeps) => Promise<T>): Promise<T> {
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    const services = createServices(this.env);
    try {
      return await work({
        db,
        bucket: this.env.BUCKET,
        credentials: services.credentials,
        outboundFetch: services.outboundFetch ?? fetch,
        secrets: {
          signingKey: this.env.SIGNING_KEY,
          signingKeysRetired: this.env.SIGNING_KEYS_RETIRED,
          encryptionKey: this.env.ENCRYPTION_KEY,
        },
        now: Date.now(),
      });
    } catch (error) {
      if (!isD1DailyLimitError(error)) throw error;
      const now = Date.now();
      await usageMeter(this.env).setPlatformLimit(now, nextUtcMidnight(now));
      throw new D1LimitPause(nextUtcMidnight(now) + RESET_MARGIN_MS);
    } finally {
      await db.meter.flush().catch((error) => console.error("Usage report failed", error));
    }
  }

  async run(event: WorkflowEvent<BackupJob>, step: WorkflowStep): Promise<string> {
    const job = event.payload;
    const runner: BackupRunner = {
      step: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        for (let pause = 0; ; pause++) {
          const label = pause === 0 ? name : `${name} (after D1 pause ${pause})`;
          // Step results are plain JSON objects, so the cast only drops the Serializable wrapper.
          const outcome = (await step.do(label, STEP, async () => {
            try {
              return { kind: "ok", value: await work() } as never;
            } catch (error) {
              if (error instanceof D1LimitPause) {
                return { kind: "limit", resumeAt: error.resumeAt } as never;
              }
              throw error;
            }
          })) as Guarded<T>;
          if (outcome.kind === "ok") return outcome.value;
          await step.sleepUntil(`wait for the D1 reset ${pause + 1}: ${name}`, outcome.resumeAt);
        }
      },
      sleepUntil: (name, until) => step.sleepUntil(name, until),
    };
    const steps = backupSteps((work) => this.withDeps(work), job);
    try {
      return await driveBackup(runner, steps);
    } catch (error) {
      console.error("Backup run failed", job, error);
      await step.do("mark failed after error", STEP, () =>
        this.withDeps((deps) =>
          failBackup(deps, job, "The backup stopped on an unexpected error. Try again."),
        ),
      );
      return "failed";
    }
  }
}
