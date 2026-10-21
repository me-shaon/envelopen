import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  driveRestore,
  type RestoreDeps,
  type RestoreJob,
  type RestoreRunner,
  restoreSteps,
} from "@envelopen/core";
import { createDb, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import {
  durableAttemptLimiter,
  RESTORE_PASSPHRASE_KEY,
  RESTORE_PASSPHRASE_RULE,
} from "../auth/rate-limit-do";
import { usageMeter, usageReader, usageSink } from "../do/usage";
import {
  createServices,
  forgetImportedSigningKeys,
  restoreStarter,
  settingsCache,
} from "../services";

// The restore Workflow (U5, KTD3). One instance runs one part of a restore: the
// passphrase key derivation (one PBKDF2 segment per step), the opening of the backup,
// then one step per backup chunk, then the finish (packages/core/src/backup/restore.ts).
//
// - Before each chunk, the run checks the D1 rows written today. When the chunk does not
//   fit the daily write budget, the run sleeps until after 00:00 UTC and goes on from
//   the last committed chunk.
// - On the D1 daily limit, a step sets the platform_limit flag, sleeps until after
//   00:00 UTC, and tries the same step again, as the backup Workflow does.
// - Workflows allow 1,024 steps per instance. A long restore starts a new instance with
//   the next generation, which goes on from the committed position.
// - Another error is retried three times, then the run is marked failed with its step.
//   A new start from the first-run screen, with the passphrase, goes on from there.
//
// Free-plan budget per step: one ranged R2 read, one AES-GCM pass over the chunk, one D1
// batch of parent lookups, and one D1 batch with the rows and the progress.

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

export class RestoreWorkflow extends WorkflowEntrypoint<Env, RestoreJob> {
  /**
   * Runs one step's work on a fresh metered connection, and reports its writes. On the
   * D1 daily limit, it sets the platform_limit flag and throws D1LimitPause.
   */
  private async withDeps<T>(work: (deps: RestoreDeps) => Promise<T>): Promise<T> {
    const services = createServices(this.env);
    const cipher = services.credentials;
    const encryptionKey = this.env.ENCRYPTION_KEY;
    if (!cipher || !encryptionKey) throw new Error("ENCRYPTION_KEY is missing.");
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    try {
      return await work({
        db,
        bucket: this.env.BUCKET,
        cipher,
        encryptionKey,
        signingKey: this.env.SIGNING_KEY,
        signingKeysRetired: this.env.SIGNING_KEYS_RETIRED,
        usage: usageReader(this.env),
        settingsCache: settingsCache(this.env),
        onWrongPassphrase: async () => {
          await durableAttemptLimiter(this.env.AUTH_RATE_LIMITER).record(
            RESTORE_PASSPHRASE_KEY,
            RESTORE_PASSPHRASE_RULE,
          );
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

  async run(event: WorkflowEvent<RestoreJob>, step: WorkflowStep): Promise<string> {
    const job = event.payload;
    const runner: RestoreRunner = {
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
    const steps = restoreSteps((work) => this.withDeps(work), job, restoreStarter(this.env));
    const result = await driveRestore(runner, steps);
    // The token signer of this isolate reads the imported signing keys again.
    if (result === "succeeded") forgetImportedSigningKeys();
    return result;
  }
}
