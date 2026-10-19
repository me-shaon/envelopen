// The Workers plan limits that matter most to Envelopen, from the guides (R3, R4). The
// first-run screen shows them, and the usage view shows them next to the measured
// usage. The Worker cannot read the account's plan, so both columns are listed.

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
