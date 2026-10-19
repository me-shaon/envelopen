import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type ChunkOutcome,
  failImport,
  finishImport,
  IMPORT_MAX_CHUNKS,
  type ImportDeps,
  ImportFileError,
  type ImportJob,
  processImportChunk,
  requireService,
} from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { createServices } from "../services";

// The import Workflow (U6). One instance runs one preview run or one import run of a
// CSV import. Each chunk of the file is one step, sized for the Workers Free limits
// (packages/core/src/import/process.ts). The steps return small, serializable results,
// so a replay rebuilds the duplicate check from them.
//
// - On the D1 daily limit, the run sleeps until after 00:00 UTC and tries the chunk again.
// - A file problem (for example a row longer than the read window) fails the import.
// - Another error is retried three times, then the import fails.
// In every end state the uploaded CSV is deleted, except after a preview, which the
// import run needs.

const CHUNK_STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

type StepOutcome = ChunkOutcome | { kind: "failed"; message: string };

export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportJob> {
  private deps(): ImportDeps {
    const services = createServices(this.env);
    return {
      db: createDb(this.env),
      services: {
        bucket: requireService(services, "bucket"),
        hashEmail: requireService(services, "hashEmail"),
      },
    };
  }

  async run(event: WorkflowEvent<ImportJob>, step: WorkflowStep): Promise<string> {
    const job = event.payload;
    const seen = new Set<string>();
    let offset = 0;
    let rowsWritten = 0;
    let pauses = 0;

    try {
      for (let index = 0; index < IMPORT_MAX_CHUNKS; ) {
        const name = `${job.mode} chunk ${index}${pauses > 0 ? ` (after pause ${pauses})` : ""}`;
        const outcome = await step.do(name, CHUNK_STEP, async (): Promise<StepOutcome> => {
          try {
            return await processImportChunk(this.deps(), job, offset, seen);
          } catch (error) {
            if (error instanceof ImportFileError) return { kind: "failed", message: error.message };
            throw error;
          }
        });
        if (outcome.kind === "stale") return "stale";
        if (outcome.kind === "failed") {
          await step.do("mark failed", () => failImport(this.deps(), job, outcome.message));
          return "failed";
        }
        if (outcome.kind === "paused") {
          pauses += 1;
          await step.sleepUntil(`wait for the D1 reset ${pauses}`, outcome.resumeAt);
          continue;
        }
        for (const key of outcome.seen) seen.add(key);
        rowsWritten += outcome.rowsWritten;
        offset = outcome.nextOffset;
        index += 1;
        if (outcome.done) {
          const total = rowsWritten;
          await step.do("finish", () => finishImport(this.deps(), job, { rowsWritten: total }));
          return "completed";
        }
      }
      await step.do("mark failed", () =>
        failImport(this.deps(), job, "The file has too many rows for one import. Split it."),
      );
      return "failed";
    } catch (error) {
      console.error("Import run failed", job, error);
      await step.do("mark failed after error", () =>
        failImport(this.deps(), job, "The import stopped on an unexpected error. Try again."),
      );
      return "failed";
    }
  }
}
