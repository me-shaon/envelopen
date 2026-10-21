import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  MAX_WELCOME_STEPS,
  planStep,
  runWelcomeStep,
  type StepOutcome,
  type StepPlan,
  type WelcomeJob,
  type WelcomeStepDeps,
} from "@envelopen/core";
import { createDb, type DbConnection, isD1DailyLimitError, nextUtcMidnight } from "@envelopen/db";
import { pendingUnsubscribedContacts, unsubscribeLedger } from "../do/unsubscribes";
import { activeLimit, usageMeter, usageSink } from "../do/usage";
import { createServices, tokenSigner } from "../services";

// The welcome series Workflow (U10, KTD8). One instance sends one series to one contact.
// The instance id is `welcome-<contactId>-<seriesId>`, and the payload holds only these
// ids, so the instance state has no address.
//
// For each position from 1 to 5:
//   1. `plan <n>`: read the delay of the step at the position now, so an edit applies to
//      the steps that have not run. No step at the position ends the run.
//   2. `wait <n>`: sleep the delay. A sleeping instance does not count against the
//      concurrency limit, so long delays are cheap.
//   3. `send <n>`: check the contact again and send (packages/core/src/welcome/run.ts).
//      A provider refusal throws, and the step retries with backoff. After the last
//      retry, the row stays `failed` and the run goes on with the next position.
//
// A stop (unsubscribed, suppressed, erased, left the list, series off or deleted) ends
// the run. At the D1 daily limit or past the reserved budget (KTD9, U11), the send step
// sleeps until after 00:00 UTC and runs again.

/** Provider refusals get 4 retries: about 1, 2, 4, and 8 minutes later. */
export const SEND_STEP = {
  retries: { limit: 4, delay: "1 minute", backoff: "exponential" },
  timeout: "2 minutes",
} as const;
const READ_STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;
/** Wait a little past 00:00 UTC before the run tries D1 again. */
const RESET_MARGIN_MS = 5 * 60 * 1000;
/** The most pauses for the daily limit before one step gives up. */
const MAX_PAUSES = 30;

type Planned = StepPlan | { kind: "limit"; until: number };

export class WelcomeWorkflow extends WorkflowEntrypoint<Env, WelcomeJob> {
  /** Runs work on a fresh metered connection and reports its writes. */
  private async withDb<T>(work: (db: DbConnection) => Promise<T>): Promise<T> {
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    try {
      return await work(db);
    } finally {
      await db.meter.flush().catch((error) => console.error("Usage report failed", error));
    }
  }

  private async deps(db: DbConnection): Promise<WelcomeStepDeps> {
    const services = createServices(this.env);
    const { credentials, hashEmail } = services;
    if (!credentials) throw new Error("ENCRYPTION_KEY is missing.");
    if (!hashEmail) throw new Error("SIGNING_KEY is missing.");
    const meter = usageMeter(this.env);
    return {
      db,
      services: { credentials, hashEmail, outboundFetch: services.outboundFetch ?? fetch },
      signer: await tokenSigner(this.env),
      usage: async () => {
        const status = await meter.status();
        return {
          limited: activeLimit(status, Date.now()) !== null,
          unsubscribesPending: status.unsubscribesPending === true,
        };
      },
      pendingUnsubscribes: (workspaceId, contactIds) =>
        pendingUnsubscribedContacts(unsubscribeLedger(this.env), db, workspaceId, contactIds),
      // KTD9: the reserved budget for automation. U11 asks the UsageMeter here.
      budget: async () => "ok",
      now: () => Date.now(),
    };
  }

  /** Marks the platform limit after D1 refused a write, and returns when to try again. */
  private async limitReached(): Promise<number> {
    const now = Date.now();
    await usageMeter(this.env).setPlatformLimit(now, nextUtcMidnight(now));
    return nextUtcMidnight(now);
  }

  async run(event: WorkflowEvent<WelcomeJob>, step: WorkflowStep): Promise<string> {
    const job: WelcomeJob = {
      workspaceId: event.payload.workspaceId,
      seriesId: event.payload.seriesId,
      contactId: event.payload.contactId,
    };
    for (let position = 1; position <= MAX_WELCOME_STEPS; position++) {
      let plan: Planned = { kind: "end" };
      for (let pause = 0; pause <= MAX_PAUSES; pause++) {
        const label = pause === 0 ? `plan ${position}` : `plan ${position} (after pause ${pause})`;
        // The results are plain JSON objects, so the cast only drops the Serializable wrapper.
        plan = (await step.do(label, READ_STEP, () =>
          this.withDb(async (db) => {
            try {
              return await planStep(db, job, position);
            } catch (error) {
              if (!isD1DailyLimitError(error)) throw error;
              return { kind: "limit", until: await this.limitReached() };
            }
          }),
        )) as Planned;
        if (plan.kind !== "limit") break;
        await step.sleepUntil(`wait for the D1 reset: ${label}`, plan.until + RESET_MARGIN_MS);
      }
      if (plan.kind !== "step") return "done";
      if (plan.delayMinutes > 0) {
        await step.sleep(`wait ${position}`, plan.delayMinutes * 60 * 1000);
      }

      let outcome: StepOutcome | null = null;
      for (let pause = 0; pause <= MAX_PAUSES; pause++) {
        const label = pause === 0 ? `send ${position}` : `send ${position} (after pause ${pause})`;
        try {
          outcome = (await step.do(label, SEND_STEP, () =>
            this.withDb(async (db) => {
              const result = await runWelcomeStep(await this.deps(db), job, position);
              if (result.kind === "defer" && result.reason === "platform_limit") {
                await this.limitReached();
              }
              return result;
            }),
          )) as StepOutcome;
        } catch (error) {
          // The retries ran out. The row says failed, and the next step goes on.
          console.error(`Welcome step ${position} of series ${job.seriesId} failed`, error);
          outcome = null;
          break;
        }
        if (outcome.kind !== "defer") break;
        await step.sleepUntil(`wait for the reset: ${label}`, outcome.until + RESET_MARGIN_MS);
      }
      if (outcome?.kind === "stopped") return `stopped: ${outcome.reason}`;
      if (outcome?.kind === "end") return "done";
    }
    return "done";
  }
}
