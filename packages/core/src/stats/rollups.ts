import type { Database, EmailEventType } from "@envelopen/db";
import { type CompiledQuery, type Kysely, sql } from "kysely";

// Hourly and daily rollups (KTD32). The EventBuffer flush adds its events here, and the
// send consumer adds the `sent` counts (campaigns/batch.ts). Dashboards read only these
// tables (U11), so a raw event that the retention job deletes still counts.
//
// - `campaign_stats_hourly`: per campaign and hour, for the 48-hour view.
// - `campaign_stats_daily`: per campaign and UTC day.
// - `workspace_stats_daily`: per workspace and UTC day. It has no machine-open or
//   bot-click columns: the workspace totals count people only.
//
// Machine opens and bot clicks are stored and counted apart (KTD29). They never add to
// `opens`, `unique_opens`, `clicks`, or `unique_clicks`.

export const HOUR_MS = 60 * 60 * 1000;

export const COUNTERS = [
  "delivered",
  "opens",
  "unique_opens",
  "machine_opens",
  "clicks",
  "unique_clicks",
  "bot_clicks",
  "bounces_hard",
  "bounces_soft",
  "complaints",
  "unsubscribes",
] as const;

export type Counter = (typeof COUNTERS)[number];
export type Counts = Partial<Record<Counter, number>>;

const WORKSPACE_COUNTERS = COUNTERS.filter(
  (counter) => counter !== "machine_opens" && counter !== "bot_clicks",
);

/** One event as the rollups see it. `unique` marks the recipient's first human open or click. */
export interface RollupEvent {
  campaignId: number;
  type: EmailEventType;
  machine: boolean;
  bot: boolean;
  unique: boolean;
  occurredAt: number;
}

/** The counters that one event adds. A `failed` event adds none. */
export function countersOf(event: RollupEvent): Counts {
  switch (event.type) {
    case "delivered":
      return { delivered: 1 };
    case "open":
      if (event.machine) return { machine_opens: 1 };
      return event.unique ? { opens: 1, unique_opens: 1 } : { opens: 1 };
    case "click":
      if (event.bot) return { bot_clicks: 1 };
      return event.unique ? { clicks: 1, unique_clicks: 1 } : { clicks: 1 };
    case "bounce_hard":
      return { bounces_hard: 1 };
    case "bounce_soft":
      return { bounces_soft: 1 };
    case "complaint":
      return { complaints: 1 };
    case "unsubscribe":
      return { unsubscribes: 1 };
    default:
      return {};
  }
}

export function utcHour(time: number): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

export function utcDayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export interface Rollups {
  /** Key `<campaign>|<hour>`. */
  hourly: Map<string, { campaignId: number; hour: number; counts: Counts }>;
  /** Key `<campaign>|<day>`. */
  daily: Map<string, { campaignId: number; day: string; counts: Counts }>;
  /** Key `<day>`. */
  workspace: Map<string, { day: string; counts: Counts }>;
}

function add(target: Counts, counts: Counts): void {
  for (const [counter, value] of Object.entries(counts) as [Counter, number][]) {
    target[counter] = (target[counter] ?? 0) + value;
  }
}

/** Sums the events into rollup rows. Rows without a counter are left out. */
export function aggregateRollups(events: readonly RollupEvent[]): Rollups {
  const rollups: Rollups = { hourly: new Map(), daily: new Map(), workspace: new Map() };
  for (const event of events) {
    const counts = countersOf(event);
    if (Object.keys(counts).length === 0) continue;
    const hour = utcHour(event.occurredAt);
    const day = utcDayOf(event.occurredAt);
    const hourly = rollups.hourly.get(`${event.campaignId}|${hour}`) ?? {
      campaignId: event.campaignId,
      hour,
      counts: {},
    };
    add(hourly.counts, counts);
    rollups.hourly.set(`${event.campaignId}|${hour}`, hourly);
    const daily = rollups.daily.get(`${event.campaignId}|${day}`) ?? {
      campaignId: event.campaignId,
      day,
      counts: {},
    };
    add(daily.counts, counts);
    rollups.daily.set(`${event.campaignId}|${day}`, daily);
    const workspace = rollups.workspace.get(day) ?? { day, counts: {} };
    add(workspace.counts, counts);
    rollups.workspace.set(day, workspace);
  }
  return rollups;
}

/**
 * An upsert that adds counters to a rollup table. The rows travel as one JSON parameter,
 * read with `json_each`, so one statement covers any number of rows and stays far below
 * D1's 100 bound parameters.
 */
function upsert(
  db: Kysely<Database>,
  workspaceId: number,
  table: "campaign_stats_hourly" | "campaign_stats_daily" | "workspace_stats_daily",
  keys: readonly string[],
  counters: readonly Counter[],
  rows: (string | number)[][],
): CompiledQuery {
  const columns = [...keys, ...counters];
  const selects = columns.map((_, index) => sql.raw(`json_extract(value, '$[${index}]')`));
  const updates = counters.map((counter) =>
    sql.raw(`${counter} = ${counter} + excluded.${counter}`),
  );
  // `WHERE true` lets SQLite parse the ON CONFLICT clause after INSERT ... SELECT.
  return sql`INSERT INTO ${sql.table(table)} (workspace_id, ${sql.join(columns.map((column) => sql.ref(column)))})
SELECT ${workspaceId}, ${sql.join(selects)} FROM json_each(${JSON.stringify(rows)}) WHERE true
ON CONFLICT (${sql.raw(table === "workspace_stats_daily" ? "workspace_id" : "campaign_id")}, ${sql.ref(keys.at(-1) as string)}) DO UPDATE SET ${sql.join(updates)}`.compile(
    db,
  );
}

function values(counts: Counts, counters: readonly Counter[]): number[] {
  return counters.map((counter) => counts[counter] ?? 0);
}

/** At most three statements: hourly, daily, and workspace daily. */
export function rollupQueries(
  db: Kysely<Database>,
  workspaceId: number,
  rollups: Rollups,
): CompiledQuery[] {
  const queries: CompiledQuery[] = [];
  if (rollups.hourly.size > 0) {
    queries.push(
      upsert(
        db,
        workspaceId,
        "campaign_stats_hourly",
        ["campaign_id", "hour"],
        COUNTERS,
        [...rollups.hourly.values()].map((row) => [
          row.campaignId,
          row.hour,
          ...values(row.counts, COUNTERS),
        ]),
      ),
    );
  }
  if (rollups.daily.size > 0) {
    queries.push(
      upsert(
        db,
        workspaceId,
        "campaign_stats_daily",
        ["campaign_id", "day"],
        COUNTERS,
        [...rollups.daily.values()].map((row) => [
          row.campaignId,
          row.day,
          ...values(row.counts, COUNTERS),
        ]),
      ),
    );
  }
  const workspaceRows = [...rollups.workspace.values()].filter((row) =>
    WORKSPACE_COUNTERS.some((counter) => (row.counts[counter] ?? 0) > 0),
  );
  if (workspaceRows.length > 0) {
    queries.push(
      upsert(
        db,
        workspaceId,
        "workspace_stats_daily",
        ["day"],
        WORKSPACE_COUNTERS,
        workspaceRows.map((row) => [row.day, ...values(row.counts, WORKSPACE_COUNTERS)]),
      ),
    );
  }
  return queries;
}
