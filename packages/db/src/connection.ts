import { Kysely, type KyselyPlugin } from "kysely";
import { D1Dialect } from "kysely-d1";
import { type Atomic, createAtomic } from "./atomic";
import { createWriteMeter, meterD1, type UsageSink, type WriteMeter } from "./metering";
import type { Database } from "./schema";
import { WorkspaceScopePlugin } from "./workspace-scope";

/** The bindings that the database layer needs. */
export interface DbEnv {
  DB: D1Database;
}

export interface CreateDbOptions {
  /** Receives the rows written when the caller flushes the meter (U9: the UsageMeter DO). */
  usageSink?: UsageSink;
  /** Use an existing meter, for example to share one across several connections in one invocation. */
  meter?: WriteMeter;
  /** Fail tenant-table queries without a workspace_id condition (KTD4). Tests turn it on. */
  enforceWorkspaceScope?: boolean;
  plugins?: KyselyPlugin[];
}

export interface DbConnection {
  db: Kysely<Database>;
  atomic: Atomic;
  meter: WriteMeter;
  /** The metered binding, for code that needs D1 directly. */
  d1: D1Database;
}

/**
 * Creates the database connection for one invocation. Kysely and the atomic helper
 * both use the metered binding (KTD24). At the end of the invocation, report the
 * writes with `ctx.waitUntil(meter.flush())`. The connection holds no global state.
 */
export function createDb(env: DbEnv, options: CreateDbOptions = {}): DbConnection {
  const meter = options.meter ?? createWriteMeter(options.usageSink);
  const d1 = meterD1(env.DB, meter);
  const plugins = [...(options.plugins ?? [])];
  if (options.enforceWorkspaceScope) plugins.push(new WorkspaceScopePlugin());
  const db = new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }), plugins });
  return { db, atomic: createAtomic(d1), meter, d1 };
}
