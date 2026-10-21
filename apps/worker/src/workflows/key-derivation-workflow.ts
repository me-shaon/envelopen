import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type CredentialCipher,
  driveKeyDerivation,
  type KeyDerivationJob,
  keyDerivationSteps,
} from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { usageSink } from "../do/usage";
import { createServices } from "../services";

// The key derivation Workflow (U4, KTD2). PBKDF2-SHA256 with 600,000 iterations takes
// about 40 ms of CPU, and Workers Free gives a request or a step 10 ms. One instance
// derives the key of one passphrase: one step per segment of 100,000 iterations (about
// 7 ms each), then a finish step (packages/core/src/backup/derivation.ts).
//
// The payload holds only the derivation id and the segment count. The passphrase and
// the chained PBKDF2 value stay in the D1 row, sealed with ENCRYPTION_KEY, and the end
// of the derivation clears them. Step results hold no secret.

const STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

export class KeyDerivationWorkflow extends WorkflowEntrypoint<Env, KeyDerivationJob> {
  /** Runs one step's work on a fresh metered connection, and reports its writes. */
  private async withDb<T>(
    work: (db: DbConnection, cipher: CredentialCipher, now: number) => Promise<T>,
  ): Promise<T> {
    const cipher = createServices(this.env).credentials;
    if (!cipher) throw new Error("ENCRYPTION_KEY is missing.");
    const db = createDb(this.env, { usageSink: usageSink(this.env) });
    try {
      return await work(db, cipher, Date.now());
    } finally {
      await db.meter.flush().catch((error) => console.error("Usage report failed", error));
    }
  }

  async run(event: WorkflowEvent<KeyDerivationJob>, step: WorkflowStep): Promise<string> {
    const job = event.payload;
    return driveKeyDerivation(
      {
        // Step results are plain JSON objects, so the cast only drops the Serializable wrapper.
        step: async <T>(name: string, work: () => Promise<T>) =>
          (await step.do(name, STEP, () => work() as Promise<never>)) as T,
      },
      keyDerivationSteps((work) => this.withDb(work), job),
      job,
    );
  }
}
