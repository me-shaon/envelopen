// The Workers plan limits that matter most to Envelopen, from the guides (R3, R4). The
// first-run screen shows them, and the usage view shows them next to the measured
// usage. The Worker cannot read the account's plan, so both columns are listed. The
// owner sets the plan in Settings (`workers_plan`, U11), and the usage view marks it.

/** The Workers plans that the owner can choose in Settings. */
export const WORKERS_PLANS = ["free", "paid"] as const;
export type WorkersPlan = (typeof WORKERS_PLANS)[number];

/**
 * The share of the daily D1 writes that welcome steps can use (KTD9, R17). Past it, a
 * welcome step waits until after 00:00 UTC. The rest of the day's writes stay free for
 * campaigns, confirmation emails, and unsubscribes. The value is fixed for now.
 */
export const WELCOME_RESERVE_RATIO = 0.7;

/** The decision of the reserve check for a welcome step (KTD9). */
export type BudgetDecision = "ok" | "defer";

/** The D1 rows written per day after which welcome steps wait. */
export function reservedThreshold(dailyLimit: number): number {
  return Math.floor(dailyLimit * WELCOME_RESERVE_RATIO);
}

/**
 * The reserve check for a welcome step. On Workers Paid there is no daily D1 write
 * limit, so the check is off. On Free, a step waits from the threshold on.
 */
export function welcomeReserve(
  plan: WorkersPlan,
  rowsWritten: number,
  dailyLimit: number,
): BudgetDecision {
  if (plan === "paid") return "ok";
  return rowsWritten >= reservedThreshold(dailyLimit) ? "defer" : "ok";
}

export interface PlanLimit {
  id: string;
  label: string;
  free: string;
  paid: string;
}

export const PLAN_LIMITS: readonly PlanLimit[] = [
  { id: "requests", label: "Worker requests", free: "100,000 per day", paid: "No daily limit" },
  { id: "cpu", label: "CPU time per request", free: "10 ms", paid: "30 s (up to 5 min)" },
  { id: "subrequests", label: "Subrequests per request", free: "50", paid: "10,000" },
  { id: "d1_writes", label: "D1 rows written", free: "100,000 per day", paid: "No daily limit" },
  { id: "d1_reads", label: "D1 rows read", free: "5 million per day", paid: "No daily limit" },
  { id: "d1_size", label: "D1 database size", free: "500 MB", paid: "10 GB" },
];
