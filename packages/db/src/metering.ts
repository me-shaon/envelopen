// Free-tier write metering (KTD24).
//
// kysely-d1 drops `meta.rows_written`, so this proxy wraps the `env.DB` binding
// before it reaches the dialect and the atomic helper. It adds up rows_written from
// every statement and batch in one invocation. At the end of the invocation the
// caller flushes the total to a sink. The UsageMeter Durable Object (U9) is that sink.

/** Receives the rows written since the last flush. Called at most once per flush. */
export type UsageSink = (rowsWritten: number) => Promise<void> | void;

export interface WriteMeter {
  /** All rows written through this meter since it was created. */
  readonly rowsWritten: number;
  /** Rows written since the last successful flush. */
  readonly pending: number;
  /** Adds rows written. The metered binding calls it. */
  record(rowsWritten: number): void;
  /**
   * Reports the pending rows to the sink, once, and returns the number reported.
   * Does not call the sink when nothing is pending. If the sink throws, the rows
   * stay pending and the error propagates.
   */
  flush(): Promise<number>;
}

/** Creates a meter for one invocation. Do not share a meter across requests. */
export function createWriteMeter(sink?: UsageSink): WriteMeter {
  let total = 0;
  let pending = 0;
  return {
    get rowsWritten() {
      return total;
    },
    get pending() {
      return pending;
    },
    record(rowsWritten) {
      if (!Number.isFinite(rowsWritten) || rowsWritten <= 0) return;
      total += rowsWritten;
      pending += rowsWritten;
    },
    async flush() {
      const amount = pending;
      if (amount === 0) return 0;
      // Take the rows out first, so writes that finish during the sink call stay pending.
      pending -= amount;
      try {
        await sink?.(amount);
      } catch (error) {
        pending += amount;
        throw error;
      }
      return amount;
    },
  };
}

function rowsWrittenOf(result: { meta?: { rows_written?: number } } | null | undefined): number {
  return result?.meta?.rows_written ?? 0;
}

/**
 * Prepared statement wrapper. `first()` and `raw()` on the native statement return no
 * `meta`, so this wrapper runs them through `all()` and shapes the result the same way.
 */
class MeteredStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly meter: WriteMeter,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return wrapStatement(this.inner.bind(...values), this.meter);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.run<T>();
    this.meter.record(rowsWrittenOf(result));
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.all<T>();
    this.meter.record(rowsWrittenOf(result));
    return result;
  }

  async first<T>(colName?: string): Promise<T | null> {
    const { results } = await this.all<Record<string, unknown>>();
    const row = results[0];
    if (row === undefined) return null;
    if (colName === undefined) return row as T;
    // Same error as the native first() for a missing column.
    if (row[colName] === undefined) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`);
    }
    return row[colName] as T;
  }

  /**
   * Note: the rows come from `all()`, so duplicate column names in one result keep
   * only the last value, and `columnNames` is empty when there are no rows.
   */
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { results } = await this.all<Record<string, unknown>>();
    const rows = results.map((row) => Object.values(row) as T);
    if (!options?.columnNames) return rows;
    const first = results[0];
    const columns = (first ? Object.keys(first) : []) as T;
    return [columns, ...rows];
  }
}

function wrapStatement(statement: D1PreparedStatement, meter: WriteMeter): D1PreparedStatement {
  return new MeteredStatement(statement, meter) as unknown as D1PreparedStatement;
}

/** The native statement, so the native batch() gets the objects it expects. */
function unwrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
  return statement instanceof MeteredStatement ? statement.inner : statement;
}

type BatchTarget = Pick<D1Database, "batch">;

async function meteredBatch<T>(
  target: BatchTarget,
  statements: D1PreparedStatement[],
  meter: WriteMeter,
): Promise<D1Result<T>[]> {
  const results = await target.batch<T>(statements.map(unwrapStatement));
  for (const result of results) meter.record(rowsWrittenOf(result));
  return results;
}

function meterSession(session: D1DatabaseSession, meter: WriteMeter): D1DatabaseSession {
  return {
    prepare: (query: string) => wrapStatement(session.prepare(query), meter),
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      meteredBatch<T>(session, statements, meter),
    getBookmark: () => session.getBookmark(),
  } as D1DatabaseSession;
}

/**
 * Wraps a D1 binding so that every `run`, `all`, `first`, `raw`, and `batch` result
 * adds its `meta.rows_written` to the meter. Sessions from `withSession()` are metered too.
 * `exec()` returns no row counts, so it passes through unmetered. Migrations use it, not services.
 */
export function meterD1(db: D1Database, meter: WriteMeter): D1Database {
  return {
    prepare: (query: string) => wrapStatement(db.prepare(query), meter),
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      meteredBatch<T>(db, statements, meter),
    exec: (query: string) => db.exec(query),
    withSession: (constraintOrBookmark?: string) =>
      meterSession(db.withSession(constraintOrBookmark), meter),
    dump: () => db.dump(),
  } as D1Database;
}
