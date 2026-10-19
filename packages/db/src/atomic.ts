import type {
  Compilable,
  CompiledQuery,
  InsertObject,
  InsertQueryBuilder,
  InsertResult,
  Kysely,
} from "kysely";

/** A Kysely query builder, or a query that is already compiled. */
export type AtomicQuery = Compilable<unknown> | CompiledQuery<unknown>;

/** Runs a group of queries in one D1 batch: all of them commit, or none do. */
export type Atomic = <T = Record<string, unknown>>(
  queries: ReadonlyArray<AtomicQuery>,
) => Promise<D1Result<T>[]>;

/**
 * Creates the atomic helper (KTD2). kysely-d1 has no transactions, so this compiles
 * each Kysely query and sends the group through `D1Database.batch()`, which D1 runs
 * as one transaction. Pass the metered binding, so the batch counts toward the meter.
 * Compiling runs the Kysely plugins, so the workspace-scope check applies here too.
 */
export function createAtomic(d1: D1Database): Atomic {
  return async <T>(queries: ReadonlyArray<AtomicQuery>) => {
    // D1 rejects an empty batch. An empty group has nothing to commit.
    if (queries.length === 0) return [];
    const statements = queries.map((query) => {
      const compiled = "compile" in query ? query.compile() : query;
      return d1.prepare(compiled.sql).bind(...compiled.parameters);
    });
    return d1.batch<T>(statements);
  };
}

/** D1 accepts at most 100 bound parameters in one query. */
export const D1_MAX_BOUND_PARAMETERS = 100;

export interface ChunkedInsertOptions<DB, TB extends keyof DB & string> {
  /** Changes each chunk's query, for example to add `onConflict(...)`. */
  modify?: (
    query: InsertQueryBuilder<DB, TB, InsertResult>,
  ) => InsertQueryBuilder<DB, TB, InsertResult>;
  /** Defaults to the D1 limit. */
  maxParameters?: number;
}

/**
 * Builds multi-row inserts that each stay within D1's bound-parameter limit (KTD20).
 * Run the queries one by one, or pass them to `atomic()` to commit them together.
 *
 * The chunk size is exact: the helper compiles a probe row that has every column, so
 * parameters that `modify` adds (for example in `onConflict`) count as well.
 */
export function chunkedInsert<DB, TB extends keyof DB & string>(
  db: Kysely<DB>,
  table: TB,
  rows: ReadonlyArray<InsertObject<DB, TB>>,
  options: ChunkedInsertOptions<DB, TB> = {},
): InsertQueryBuilder<DB, TB, InsertResult>[] {
  if (rows.length === 0) return [];
  const maxParameters = options.maxParameters ?? D1_MAX_BOUND_PARAMETERS;
  const modify = options.modify ?? ((query) => query);
  const build = (chunk: ReadonlyArray<InsertObject<DB, TB>>) =>
    modify(db.insertInto(table).values(chunk as InsertObject<DB, TB>[]));

  // Every column that any row sets. Kysely writes DEFAULT, not a parameter, for a
  // column that a row leaves out, so this count is the most one row can bind.
  const columns = new Set<string>();
  for (const row of rows) {
    for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
      if (value !== undefined) columns.add(column);
    }
  }
  const probe = Object.fromEntries([...columns].map((column) => [column, null]));
  const probeParameters = build([probe as InsertObject<DB, TB>]).compile().parameters.length;
  const fixedParameters = probeParameters - columns.size;
  const perRow = Math.max(columns.size, 1);
  const rowsPerChunk = Math.floor((maxParameters - fixedParameters) / perRow);
  if (rowsPerChunk < 1) {
    throw new Error(
      `One ${table} row needs ${probeParameters} bound parameters, more than the limit of ${maxParameters}.`,
    );
  }

  const queries: InsertQueryBuilder<DB, TB, InsertResult>[] = [];
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    queries.push(build(rows.slice(start, start + rowsPerChunk)));
  }
  return queries;
}
