import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BatchPointer,
  beginSnapshot,
  type CredentialCipher,
  createCredentialCipher,
  createEmailHasher,
  type EmailHasher,
  emptyExclusions,
  finishSnapshot,
  type PlatformLimit,
  type SendQueue,
  snapshotPage,
} from "@envelopen/core";
import type { SeededWorkspace, SeedOptions } from "@envelopen/core/testing/campaign-fixtures";
import { createDraft, seedCampaignWorkspace } from "@envelopen/core/testing/campaign-fixtures";
import { createProviderMock, type ProviderMock } from "@envelopen/core/testing/provider-mock";
import { createDb, type DbConnection } from "@envelopen/db";
import { createTokenSigner, type TokenSigner } from "@envelopen/email-render";
import type { Grant } from "../src/do/rate-limiter";
import { type LedgerClient, ledgerMeterName, unsubscribeLedger } from "../src/do/unsubscribes";
import { USAGE_METER_NAME } from "../src/do/usage";
import type { ConsumerDeps, RateLimiterClient } from "../src/queue/send-consumer";

// Shared setup of the campaign engine tests: a sendable workspace, a sending campaign
// with its snapshot, and consumer dependencies with a provider mock and a test clock.

/** The same keys as the test bindings in vitest.config.ts. */
export const ENCRYPTION_KEY = env.ENCRYPTION_KEY as string;
export const SIGNING_KEY = env.SIGNING_KEY as string;
export const T0 = Date.UTC(2026, 9, 19, 12);

export interface Keys {
  credentials: CredentialCipher;
  hashEmail: EmailHasher;
  signer: TokenSigner;
}

let keys: Promise<Keys> | undefined;

export function testKeys(): Promise<Keys> {
  keys ??= (async () => ({
    credentials: await createCredentialCipher([{ version: 1, secret: ENCRYPTION_KEY }]),
    hashEmail: await createEmailHasher(SIGNING_KEY),
    signer: await createTokenSigner([{ secret: SIGNING_KEY }]),
  }))();
  return keys;
}

export function campaignDb(): DbConnection {
  return createDb(env, { enforceWorkspaceScope: true });
}

/** A queue that records the pointers instead of delivering them. */
export function recordingQueue(): SendQueue & { sent: BatchPointer[] } {
  const sent: BatchPointer[] = [];
  return {
    sent,
    async send(pointers) {
      sent.push(...pointers);
    },
  };
}

export interface SendingCampaign {
  db: DbConnection;
  seeded: SeededWorkspace;
  campaignId: number;
  pointers: BatchPointer[];
}

/**
 * Seeds a workspace, confirms a campaign straight to `sending`, and takes the snapshot
 * with a recording queue. Returns the pointers that the snapshot dispatched.
 */
export async function sendingCampaign(
  options: SeedOptions & { type?: "regular" | "re-permission"; refs?: Record<string, string> } = {},
): Promise<SendingCampaign> {
  const db = campaignDb();
  const { credentials, hashEmail } = await testKeys();
  const seeded = await seedCampaignWorkspace(
    db,
    { credentials, hashEmail },
    { contacts: 3, ...options },
  );
  if (options.refs) {
    await db.db
      .updateTable("provider_connections")
      .set({ provider_refs: JSON.stringify(options.refs) })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.connectionId)
      .execute();
  }
  const campaignId = await createDraft(db, seeded, { type: options.type ?? "regular" });
  await db.db
    .updateTable("campaigns")
    .set({
      status: "sending",
      started_at: T0,
      connection_id: seeded.connectionId,
      link_origin: "https://envelopen.test",
    })
    .where("workspace_id", "=", seeded.workspaceId)
    .where("id", "=", campaignId)
    .execute();
  const queue = recordingQueue();
  await snapshot(db, { workspaceId: seeded.workspaceId, campaignId, startedAt: T0 }, queue);
  return { db, seeded, campaignId, pointers: queue.sent };
}

/** Runs the snapshot steps in order, as the Workflow does. */
export async function snapshot(
  db: DbConnection,
  job: { workspaceId: number; campaignId: number; startedAt: number },
  queue: SendQueue,
  pageSize?: number,
) {
  const start = await beginSnapshot(db, job);
  if (start.state === "stop") throw new Error(start.reason);
  let afterId = 0;
  let excluded = emptyExclusions();
  for (;;) {
    const page = await snapshotPage(
      db,
      queue,
      job,
      { afterId, cut: start.cut, batchSize: start.batchSize, ...(pageSize ? { pageSize } : {}) },
      T0,
    );
    if (page.kind === "stop") throw new Error(page.reason);
    excluded = {
      consent_unknown: excluded.consent_unknown + page.excluded.consent_unknown,
      suppressed: excluded.suppressed + page.excluded.suppressed,
      unsubscribed: excluded.unsubscribed + page.excluded.unsubscribed,
    };
    afterId = page.nextAfterId;
    if (page.done) break;
  }
  return finishSnapshot(db, job, excluded, T0);
}

export interface TestDeps extends ConsumerDeps {
  mock: ProviderMock;
  clock: { now: number };
  sleeps: number[];
  limit: { value: PlatformLimit | null };
  /** The UsageMeter flag and the contacts that the fake ledger reports. */
  ledger: { pending: boolean; contacts: Set<number> };
  backoffs: number[];
  /** Calls to the Durable Objects, for the subrequest budget. */
  objectCalls: { count: number };
}

/** Consumer dependencies with a provider mock, a fake clock, and in-memory objects. */
export async function testDeps(
  db: DbConnection,
  overrides: Partial<ConsumerDeps> = {},
): Promise<TestDeps> {
  const { credentials, signer } = await testKeys();
  const mock = createProviderMock();
  const clock = { now: T0 + 1000 };
  const sleeps: number[] = [];
  const backoffs: number[] = [];
  const limit: { value: PlatformLimit | null } = { value: null };
  const objectCalls = { count: 0 };
  const ledger = { pending: false, contacts: new Set<number>() };
  const limiter: RateLimiterClient = {
    async acquire(): Promise<Grant> {
      objectCalls.count++;
      return { granted: true, waitMs: 0 };
    },
    async backoff(ms) {
      objectCalls.count++;
      backoffs.push(ms);
    },
  };
  return {
    db,
    services: { credentials, outboundFetch: mock.fetch },
    signer,
    usage: {
      async gate() {
        objectCalls.count++;
        return {
          limit: limit.value && limit.value.until > clock.now ? limit.value : null,
          unsubscribesPending: ledger.pending,
        };
      },
      async setPlatformLimit(since, until) {
        objectCalls.count++;
        limit.value = { since, until };
      },
    },
    pendingUnsubscribes: async (_db, _workspaceId, contactIds) => {
      objectCalls.count++;
      return new Set(contactIds.filter((id) => ledger.contacts.has(id)));
    },
    rateLimiter: () => limiter,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.now,
    mock,
    clock,
    sleeps,
    limit,
    ledger,
    backoffs,
    objectCalls,
    ...overrides,
  };
}

export async function batchRow(db: DbConnection, workspaceId: number, batchId: number) {
  return db.db
    .selectFrom("campaign_batches")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", batchId)
    .executeTakeFirstOrThrow();
}

export async function campaignRow(db: DbConnection, workspaceId: number, campaignId: number) {
  return db.db
    .selectFrom("campaigns")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", campaignId)
    .executeTakeFirstOrThrow();
}

export async function recipientRows(db: DbConnection, workspaceId: number, campaignId: number) {
  return db.db
    .selectFrom("campaign_recipients as r")
    .innerJoin("contacts as c", (join) =>
      join.onRef("c.id", "=", "r.contact_id").on("c.workspace_id", "=", workspaceId),
    )
    .select(["r.id", "r.batch_id", "r.status", "r.skip_reason", "c.email", "r.contact_id"])
    .where("r.workspace_id", "=", workspaceId)
    .where("r.campaign_id", "=", campaignId)
    .orderBy("r.id")
    .execute();
}

/** A D1 binding that counts statements, for the per-batch budget (KTD20). */
export function countingD1(inner: D1Database): { d1: D1Database; statements: { count: number } } {
  const statements = { count: 0 };
  // The native batch() takes native statements only, so it gets the originals back.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => {
            statements.count++;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const d1 = {
    prepare: (query: string) => wrap(inner.prepare(query)),
    batch: (list: D1PreparedStatement[]) => {
      statements.count += list.length;
      return inner.batch(list.map((item) => originals.get(item) ?? item));
    },
    exec: (query: string) => inner.exec(query),
    withSession: () => inner.withSession(),
    dump: () => inner.dump(),
  } as unknown as D1Database;
  return { d1, statements };
}

export const DAILY_LIMIT_MESSAGE =
  "D1_ERROR: Your account's daily limits have been exceeded and will reset at 00:00 UTC.";

/**
 * A D1 binding that rejects every write with the Free-plan daily-limit error. With
 * `reads`, it rejects reads too, as D1 does at its daily read limit. `message` sets
 * another error, for a failure that is not the daily limit.
 */
export function limitedD1(
  inner: D1Database,
  options: { reads?: boolean; message?: string } = {},
): D1Database {
  const error = () => new Error(options.message ?? DAILY_LIMIT_MESSAGE);
  const isWrite = (sql: string) => /^\s*(insert|update|delete|with)\b/i.test(sql);
  return {
    prepare(query: string) {
      const statement = inner.prepare(query);
      if (!options.reads && !isWrite(query)) return statement;
      const failing = {
        bind: () => failing,
        run: async () => Promise.reject(error()),
        all: async () => Promise.reject(error()),
        first: async () => Promise.reject(error()),
        raw: async () => Promise.reject(error()),
      };
      return failing as unknown as D1PreparedStatement;
    },
    batch: async () => Promise.reject(error()),
    exec: (query: string) => inner.exec(query),
    withSession: () => inner.withSession(),
    dump: () => inner.dump(),
  } as unknown as D1Database;
}

/** A metered connection over a given binding, with the scope check on. */
export function dbOver(d1: D1Database): DbConnection {
  return createDb({ DB: d1 }, { enforceWorkspaceScope: true });
}

/**
 * An UnsubscribeLedger of its own for one test, with the UsageMeter that holds its flag.
 * The deployment's ledger and meter are shared by every test.
 */
export function testLedger(name = `test:${crypto.randomUUID()}`): LedgerClient & {
  name: string;
  pending(): Promise<boolean>;
} {
  const ledger = unsubscribeLedger(env, name);
  const meter = env.USAGE_METER.getByName(ledgerMeterName(name));
  return {
    name,
    record: (intents) => ledger.record(intents),
    list: (limit) => ledger.list(limit),
    find: (ref) => ledger.find(ref),
    remove: (entries) => ledger.remove(entries),
    pending: async () => (await meter.status()).unsubscribesPending === true,
  };
}

export { createProviderMock };

/**
 * A busy day on the deployment's UsageMeter: sets today's D1 rows written, so a test can
 * pass the reserved threshold (KTD9). The returned function puts the old counts back.
 */
export async function busyDay(rows: number): Promise<() => Promise<void>> {
  const stub = env.USAGE_METER.getByName(USAGE_METER_NAME);
  const day = new Date().toISOString().slice(0, 10);
  const before = await runInDurableObject(stub, async (_instance, state) =>
    state.storage.get<{ day: string; rows: number }>("rows"),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("rows", { day, rows });
  });
  return async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      if (before) await state.storage.put("rows", before);
      else await state.storage.delete("rows");
    });
  };
}
