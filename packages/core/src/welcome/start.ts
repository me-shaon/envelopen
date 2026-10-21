import type { DbConnection } from "@envelopen/db";
import { sql } from "kysely";
import type { Services } from "../services";
import { startableJobs } from "./eligibility";
import type { WelcomeJob } from "./model";

// Starts and stops of welcome series (U10, KTD8).
//
// Starts: a confirmed form signup starts the series of each list that it joins. Contact
// upsert and list add take an optional `startWelcome` flag for manual and API adds.
// Imports never start a series. A start that fails is logged and does not fail the
// action that caused it: the contact and the membership are already stored.
//
// Stops: an unsubscribe, a suppression, and an erase terminate the instances of the
// contact when the Workflow can reach them. The check before each step covers a stop
// that fails or comes too late.

/** The Workflow binding as the services use it. The Worker wraps WELCOME_WORKFLOW. */
export interface WelcomeRunner {
  /**
   * Creates one instance per job. An instance id that exists already is not an error.
   * Returns the jobs that got a new instance.
   */
  start(jobs: readonly WelcomeJob[]): Promise<WelcomeJob[]>;
  /** Terminates the instances of the jobs. A missing or finished instance is ignored. */
  stop(jobs: readonly WelcomeJob[]): Promise<void>;
}

/**
 * Starts the series of `listIds` for each contact that may start (eligibility.ts).
 * Returns the number of new instances. It never throws.
 */
export async function startWelcome(
  db: DbConnection,
  services: Partial<Pick<Services, "welcome">>,
  workspaceId: number,
  contactIds: readonly number[],
  listIds: readonly number[],
): Promise<number> {
  try {
    const runner = services.welcome;
    if (!runner) return 0;
    const jobs = await startableJobs(db, workspaceId, contactIds, listIds);
    if (jobs.length === 0) return 0;
    const started = await runner.start(jobs);
    const perSeries = new Map<number, number>();
    for (const job of started) perSeries.set(job.seriesId, (perSeries.get(job.seriesId) ?? 0) + 1);
    if (perSeries.size > 0) {
      await db.atomic(
        [...perSeries].map(([seriesId, count]) =>
          sql`UPDATE welcome_series SET entered_count = entered_count + ${count}
WHERE workspace_id = ${workspaceId} AND id = ${seriesId}`.compile(db.db),
        ),
      );
    }
    return started.length;
  } catch (error) {
    console.error("The welcome series did not start", error);
    return 0;
  }
}

/**
 * Terminates the welcome instances of the contacts: in the series of `listIds`, or in
 * every series of the workspace when it is null. It never throws.
 */
export async function stopWelcome(
  db: DbConnection,
  runner: WelcomeRunner | undefined,
  workspaceId: number,
  contactIds: readonly number[],
  listIds: readonly number[] | null = null,
): Promise<void> {
  if (!runner || contactIds.length === 0) return;
  if (listIds !== null && listIds.length === 0) return;
  try {
    let query = db.db
      .selectFrom("welcome_series")
      .select("id")
      .where("workspace_id", "=", workspaceId);
    if (listIds !== null) query = query.where("list_id", "in", [...listIds]);
    const series = await query.execute();
    const jobs = series.flatMap((row) =>
      contactIds.map((contactId) => ({ workspaceId, seriesId: row.id, contactId })),
    );
    if (jobs.length > 0) await runner.stop(jobs);
  } catch (error) {
    console.error("The welcome series did not stop", error);
  }
}
