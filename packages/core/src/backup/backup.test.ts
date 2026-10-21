import { env } from "cloudflare:workers";
import { nextUtcMidnight, TABLE_SCOPE } from "@envelopen/db";
import { describe, expect, it } from "vitest";
import {
  createApiKey,
  createOwnedWorkspace,
  createUser,
  insertContact,
  TEST_ENCRYPTION_KEY,
  TEST_SIGNING_KEY,
  testDb,
  testServices,
} from "../../test/fixtures";
import { resolveApiKey } from "../api-keys";
import { createCredentialCipher } from "../crypto/credentials";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { RECENT_SIGN_IN_MS, sessionPrincipal } from "../principal";
import { registry } from "../registry";
import type { Operation } from "../registry/operation";
import { API_KEY_SCOPES } from "../scopes";
import type { KeyDerivationJob } from "../services";
import { createKeyMaterial, decryptChunk, unwrap, WrongPassphraseError } from "./crypto";
import { driveKeyDerivation, keyDerivationSteps } from "./derivation";
import {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_SCHEMA_VERSION,
  BACKUP_TABLES,
  backupPrefix,
  decodeRows,
  decodeValue,
  encodeRows,
  MANIFEST_KEY,
  type Manifest,
  verifyManifest,
} from "./format";
import { readBackupSettings, rowsReadOnDay, writeBackupSettings } from "./model";
import {
  backupsGet,
  backupsRuns,
  backupsSetPassphrase,
  backupsStart,
  backupsUpdateSettings,
} from "./operations";
import {
  applyRetention,
  type BackupDeps,
  type BackupRunner,
  backupSteps,
  driveBackup,
  RESET_MARGIN_MS,
  startBackup,
} from "./run";

// The backup engine, the format, and the operations (U4, R1, R2, KTD2). The Workflow
// test (apps/worker/src/workflows/backup-workflow.test.ts) runs the same driver as
// Workflow steps.

const PASSPHRASE = "a long backup passphrase";
const NOW = Date.UTC(2026, 9, 21, 2, 23);

interface FakeS3 {
  fetch: typeof fetch;
  objects: Map<string, Uint8Array>;
  requests: { method: string; url: string; signed: boolean }[];
  /** When set, every request answers with this HTTP status. */
  failWith: number | null;
}

/** An S3-compatible store in memory. It checks that each request has a SigV4 signature. */
function fakeS3(): FakeS3 {
  const store: FakeS3 = {
    objects: new Map(),
    requests: [],
    failWith: null,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const signed = (request.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256");
      store.requests.push({ method: request.method, url: request.url, signed });
      if (store.failWith) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: store.failWith });
      }
      if (request.method === "PUT") {
        store.objects.set(url.pathname, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        store.objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  };
  return store;
}

const S3_INPUT = {
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "envelopen-backups",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

async function owner(signedInAt: number | null = NOW - 60_000) {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Backup");
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId, signedInAt }) };
}

/** Runs a key derivation to its end, one segment per step. */
async function finishDerivation(job: KeyDerivationJob): Promise<string> {
  const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
  return driveKeyDerivation(
    { step: (_name, work) => work() },
    keyDerivationSteps((work) => work(testDb(), cipher, NOW), job),
    job,
  );
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail.");
}

/** Sets the passphrase with low PBKDF2 costs, so a test runs fast. */
async function setPassphrase(passphrase = PASSPHRASE) {
  const material = await createKeyMaterial(passphrase, { iterations: 1000 });
  await writeBackupSettings(
    testDb(),
    {
      public_key: material.publicKey,
      kdf_salt: material.kdfSalt,
      kdf_iterations: material.kdfIterations,
      verifier: material.verifier,
      verifier_salt: material.verifierSalt,
      verifier_iterations: material.verifierIterations,
      key_set_at: NOW,
    },
    NOW,
  );
  return material;
}

interface Harness {
  clock: { now: number };
  sleeps: { name: string; until: number }[];
  steps: string[];
  runner: BackupRunner;
}

/** Runs steps directly. A sleep moves the clock forward. */
function harness(onStep?: (name: string) => Promise<void>): Harness {
  const h: Harness = {
    clock: { now: NOW },
    sleeps: [],
    steps: [],
    runner: {
      async step(name, work) {
        h.steps.push(name);
        const result = await work();
        await onStep?.(name);
        return result;
      },
      async sleepUntil(name, until) {
        h.sleeps.push({ name, until });
        h.clock.now = Math.max(h.clock.now, until);
      },
    },
  };
  return h;
}

async function runBackup(
  h: Harness,
  options: { fetch?: typeof fetch; readBudget?: number; trigger?: "schedule" | "manual" } = {},
) {
  const services = await testServices({ fetch: options.fetch ?? fakeS3().fetch });
  const conn = testDb();
  // Another test of this file can leave a run marked running.
  await conn.db
    .updateTable("backup_runs")
    .set({ status: "failed" })
    .where("status", "=", "running")
    .execute();
  const run = await startBackup(conn, services.startBackupJob, options.trigger ?? "schedule", NOW);
  const job = services.backupJobs.at(-1);
  if (!job) throw new Error("No job started.");
  const deps = (work: (deps: BackupDeps) => Promise<unknown>) =>
    work({
      db: testDb(),
      bucket: env.BUCKET,
      credentials: services.credentials,
      outboundFetch: services.outboundFetch,
      secrets: { signingKey: TEST_SIGNING_KEY, encryptionKey: TEST_ENCRYPTION_KEY },
      now: h.clock.now,
      ...(options.readBudget === undefined ? {} : { readBudget: options.readBudget }),
    });
  const result = await driveBackup(h.runner, backupSteps(deps, job));
  const row = await conn.db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  return { result, row, job };
}

async function readManifest(backupId: string): Promise<Manifest> {
  const object = await env.BUCKET.get(backupPrefix(backupId) + MANIFEST_KEY);
  if (!object) throw new Error("No manifest.");
  return (await object.json()) as Manifest;
}

async function readChunk(backupId: string, key: string): Promise<Uint8Array> {
  const object = await env.BUCKET.get(backupPrefix(backupId) + key);
  if (!object) throw new Error(`No chunk ${key}.`);
  return new Uint8Array(await object.arrayBuffer());
}

async function countRows(table: string, upTo: number | null): Promise<number> {
  if (upTo === null) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE rowid <= ?`)
    .bind(upTo)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Opens a backup with the passphrase, as U5 restore will. */
async function openBackup(manifest: Manifest, material: Awaited<ReturnType<typeof setPassphrase>>) {
  // A restore has no settings row: the manifest carries the key material.
  expect(manifest.keyMaterial).toEqual(material);
  const { dataKey, secrets } = await unwrap(
    manifest.wrappedKey,
    manifest.backupId,
    PASSPHRASE,
    manifest.keyMaterial,
  );
  await verifyManifest(manifest, dataKey);
  return { dataKey, secrets };
}

describe("backup format", () => {
  it("keeps the schema version equal to the latest migration", () => {
    const numbers = env.TEST_MIGRATIONS.map((m) => Number.parseInt(m.name.slice(0, 4), 10));
    expect(BACKUP_SCHEMA_VERSION).toBe(Math.max(...numbers));
  });

  it("covers every table of TABLE_SCOPE except the excluded ones", () => {
    const all = Object.keys(TABLE_SCOPE).sort();
    const covered = [...BACKUP_TABLES, ...Object.keys(BACKUP_EXCLUDED_TABLES)].sort();
    expect(covered).toEqual(all);
    expect(BACKUP_TABLES).not.toContain("auth_session");
  });

  it("keeps values exactly, blobs included", () => {
    const rows = [
      {
        id: 1,
        name: 'Zoë "quoted"\nline',
        ratio: 0.25,
        empty: null,
        blob: new Uint8Array([0, 255, 7]),
      },
    ];
    const [decoded] = decodeRows(encodeRows(rows));
    expect(decoded).toMatchObject({ id: 1, name: rows[0]?.name, ratio: 0.25, empty: null });
    expect(decodeValue(decoded?.blob ?? null)).toEqual(new Uint8Array([0, 255, 7]));
  });
});

describe("backup run", () => {
  it("backs up a seeded workspace: the manifest row counts match the tables", async () => {
    const { conn, workspaceId } = await owner();
    for (let i = 0; i < 5; i++)
      await insertContact(conn, workspaceId, { email: `c${i}@example.com` });
    const material = await setPassphrase();

    const h = harness();
    const { result, row } = await runBackup(h);
    expect(result).toBe("succeeded");
    expect(row).toMatchObject({ status: "succeeded", destinations: '["r2"]', error: null });

    const manifest = await readManifest(row.backup_id);
    expect(manifest.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(manifest.tables.map((t) => t.name)).toEqual([...BACKUP_TABLES]);
    for (const table of manifest.tables) {
      expect({ table: table.name, rows: table.rows }).toEqual({
        table: table.name,
        rows: await countRows(table.name, table.highWaterMark),
      });
    }
    expect(manifest.totalRows).toBe(row.row_count);
    expect(manifest.chunks.length).toBe(row.chunk_count);

    // The owner opens it with the passphrase: the tag holds and the chunks decrypt.
    const { dataKey, secrets } = await openBackup(manifest, material);
    expect(secrets).toMatchObject({
      signingKey: TEST_SIGNING_KEY,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    const emails: unknown[] = [];
    for (const chunk of manifest.chunks) {
      const plain = await decryptChunk(
        dataKey,
        manifest.backupId,
        chunk.index,
        await readChunk(manifest.backupId, chunk.key),
      );
      const rows = decodeRows(plain);
      expect(rows).toHaveLength(chunk.rows);
      if (chunk.table === "contacts") emails.push(...rows.map((r) => r.email));
    }
    expect(emails).toEqual(expect.arrayContaining(["c0@example.com", "c4@example.com"]));
  });

  it("leaves out rows inserted after the start mark", async () => {
    const { conn, workspaceId } = await owner();
    await insertContact(conn, workspaceId, { email: "before@example.com" });
    const material = await setPassphrase();
    const h = harness(async (name) => {
      if (name === "begin")
        await insertContact(testDb(), workspaceId, { email: "during@example.com" });
    });
    const { row } = await runBackup(h);
    const manifest = await readManifest(row.backup_id);
    const contacts = manifest.tables.find((t) => t.name === "contacts");
    expect(contacts?.rows).toBe(await countRows("contacts", contacts?.highWaterMark ?? null));
    const { dataKey } = await openBackup(manifest, material);
    const emails: unknown[] = [];
    for (const chunk of manifest.chunks.filter((c) => c.table === "contacts")) {
      const rows = decodeRows(
        await decryptChunk(
          dataKey,
          manifest.backupId,
          chunk.index,
          await readChunk(manifest.backupId, chunk.key),
        ),
      );
      emails.push(...rows.map((r) => r.email));
    }
    expect(emails).toContain("before@example.com");
    expect(emails).not.toContain("during@example.com");
  });

  it("fails a swapped chunk and an edited manifest", async () => {
    await owner();
    const material = await setPassphrase();
    const { row } = await runBackup(harness());
    const manifest = await readManifest(row.backup_id);
    const { dataKey } = await openBackup(manifest, material);
    const [first, second] = manifest.chunks;
    if (!first || !second) throw new Error("Expected two chunks.");
    // Chunk 1's bytes at position 0 do not decrypt.
    expect(
      await rejection(
        decryptChunk(
          dataKey,
          manifest.backupId,
          first.index,
          await readChunk(manifest.backupId, second.key),
        ),
      ),
    ).toBeInstanceOf(Error);

    await expect(verifyManifest(manifest, dataKey)).resolves.toBeUndefined();
    const edits: ((m: Manifest) => void)[] = [
      (m) => {
        m.totalRows += 1;
      },
      (m) => {
        (m.tables[0] as { rows: number }).rows += 1;
      },
      (m) => {
        m.chunks.reverse();
      },
      (m) => {
        m.wrappedKey = { ...m.wrappedKey, epk: m.keyMaterial.publicKey };
      },
      (m) => {
        m.keyMaterial = { ...m.keyMaterial, kdfIterations: 1 };
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(manifest);
      edit(copy);
      expect(await rejection(verifyManifest(copy, dataKey))).toBeInstanceOf(Error);
    }
  });

  it("rejects a wrong passphrase in unwrap", async () => {
    await owner();
    const material = await setPassphrase();
    const { row } = await runBackup(harness());
    const manifest = await readManifest(row.backup_id);
    expect(
      await rejection(
        unwrap(manifest.wrappedKey, manifest.backupId, "a wrong backup passphrase", material),
      ),
    ).toBeInstanceOf(WrongPassphraseError);
  });

  it("sleeps until after 00:00 UTC when the read budget is spent, then resumes", async () => {
    const { conn, workspaceId } = await owner();
    for (let i = 0; i < 3; i++)
      await insertContact(conn, workspaceId, { email: `r${i}@example.com` });
    const material = await setPassphrase();
    const day = new Date(NOW).toISOString().slice(0, 10);
    // The start reads a few rows, so no chunk fits today. The chunks wait for the next
    // UTC day, which starts with an empty budget.
    const budget = (await rowsReadOnDay(conn, day)) + 1_015;
    const h = harness();
    const { result, row } = await runBackup(h, { readBudget: budget });
    expect(result).toBe("succeeded");
    expect(h.sleeps.length).toBeGreaterThanOrEqual(1);
    expect(h.sleeps[0]?.until).toBe(nextUtcMidnight(NOW) + RESET_MARGIN_MS);
    // No day went over the budget.
    expect(await rowsReadOnDay(conn, day)).toBeLessThanOrEqual(budget);
    expect(row.read_day).not.toBe(day);
    const manifest = await readManifest(row.backup_id);
    await openBackup(manifest, material);
    for (const table of manifest.tables) {
      expect(table.rows).toBe(await countRows(table.name, table.highWaterMark));
    }
  });

  it("copies to S3 when it is set", async () => {
    const { conn } = await owner();
    await setPassphrase();
    const services = await testServices();
    await writeBackupSettings(
      conn,
      {
        s3_config: await services.credentials.encrypt(JSON.stringify(S3_INPUT), {
          workspaceId: 0,
          purpose: "backup_destination",
          connectionId: 1,
        }),
        s3_key_version: 1,
      },
      NOW,
    );
    const s3 = fakeS3();
    const { result, row } = await runBackup(harness(), { fetch: s3.fetch });
    expect(result).toBe("succeeded");
    expect(row.destinations).toBe('["r2","s3"]');
    expect(s3.requests.every((r) => r.signed && r.method === "PUT")).toBe(true);
    const manifestPath = `/envelopen-backups/${backupPrefix(row.backup_id)}${MANIFEST_KEY}`;
    expect(s3.objects.has(manifestPath)).toBe(true);
    expect(s3.objects.size).toBe(row.chunk_count + 1);
    await conn.db
      .updateTable("backup_settings")
      .set({ s3_config: null, s3_key_version: null })
      .execute();
  });

  it("records a partial run with the S3 error when R2 succeeds and S3 fails", async () => {
    const { conn } = await owner();
    await setPassphrase();
    const services = await testServices();
    await writeBackupSettings(
      conn,
      {
        ...(await (async () => ({
          s3_config: await services.credentials.encrypt(JSON.stringify(S3_INPUT), {
            workspaceId: 0,
            purpose: "backup_destination",
            connectionId: 1,
          }),
          s3_key_version: 1,
        }))()),
      },
      NOW,
    );
    const s3 = fakeS3();
    s3.failWith = 403;
    const { result, row } = await runBackup(harness(), { fetch: s3.fetch });
    expect(result).toBe("partial");
    expect(row).toMatchObject({ status: "partial", destinations: '["r2"]' });
    expect(row.s3_error).toContain("HTTP 403 (AccessDenied)");
    expect(row.s3_error).not.toContain(S3_INPUT.secretAccessKey);
    // One failed upload stops the S3 copy. R2 has the full backup.
    expect(s3.requests).toHaveLength(1);
    await expect(readManifest(row.backup_id)).resolves.toMatchObject({ backupId: row.backup_id });
    await conn.db
      .updateTable("backup_settings")
      .set({ s3_config: null, s3_key_version: null })
      .execute();
  });

  it("fails a scheduled run without a passphrase, and never starts one", async () => {
    const conn = testDb();
    await conn.db.updateTable("backup_settings").set({ public_key: null }).execute();
    const services = await testServices();
    const error = await rejection(startBackup(conn, services.startBackupJob, "schedule", NOW));
    expect(isOperationError(error) && error.code).toBe("invalid_input");
    expect(services.backupJobs).toEqual([]);
  });
});

describe("retention", () => {
  async function seedRun(
    backupId: string,
    status: "succeeded" | "partial" | "failed",
    daysAgo: number,
    s3 = false,
  ) {
    const conn = testDb();
    await conn.db
      .insertInto("backup_runs")
      .values({
        backup_id: backupId,
        trigger: "schedule",
        status,
        started_at: NOW - daysAgo * 86_400_000,
        finished_at: NOW - daysAgo * 86_400_000,
        chunk_count: 1,
        destinations: JSON.stringify(s3 ? ["r2", "s3"] : ["r2"]),
      })
      .execute();
    await env.BUCKET.put(`${backupPrefix(backupId)}${MANIFEST_KEY}`, "{}");
    await env.BUCKET.put(`${backupPrefix(backupId)}chunks/000000.bin`, "x");
  }

  it("removes backups past the period from R2 and S3, but never the newest successful one", async () => {
    const conn = testDb();
    await conn.db.deleteFrom("backup_runs").execute();
    await writeBackupSettings(conn, { retention_days: 14 }, NOW);
    const services = await testServices();
    await writeBackupSettings(
      conn,
      {
        s3_config: await services.credentials.encrypt(JSON.stringify(S3_INPUT), {
          workspaceId: 0,
          purpose: "backup_destination",
          connectionId: 1,
        }),
        s3_key_version: 1,
      },
      NOW,
    );
    await seedRun("old-a", "succeeded", 40, true);
    await seedRun("old-b", "partial", 20);
    await seedRun("recent-failed", "failed", 3);
    const s3 = fakeS3();
    const deleted = await applyRetention(
      { db: conn, bucket: env.BUCKET, credentials: services.credentials, outboundFetch: s3.fetch },
      NOW,
    );
    // old-b is past the period, but it is the newest backup that R2 holds.
    expect(deleted).toEqual(["old-a"]);
    expect((await env.BUCKET.list({ prefix: backupPrefix("old-a") })).objects).toEqual([]);
    expect((await env.BUCKET.list({ prefix: backupPrefix("old-b") })).objects).toHaveLength(2);
    expect(s3.requests.map((r) => r.method)).toEqual(["DELETE", "DELETE"]);
    const rows = await conn.db
      .selectFrom("backup_runs")
      .select(["backup_id", "deleted_at"])
      .orderBy("id")
      .execute();
    expect(rows).toEqual([
      { backup_id: "old-a", deleted_at: NOW },
      { backup_id: "old-b", deleted_at: null },
      { backup_id: "recent-failed", deleted_at: null },
    ]);

    // A newer success makes old-b removable.
    await seedRun("new", "succeeded", 1);
    expect(
      await applyRetention({ db: conn, bucket: env.BUCKET, outboundFetch: s3.fetch }, NOW),
    ).toEqual(["old-b"]);
    await conn.db
      .updateTable("backup_settings")
      .set({ s3_config: null, s3_key_version: null })
      .execute();
  });
});

describe("backup operations", () => {
  it("starts the key derivation from a fresh session, then uses the key, and audits it", async () => {
    const { conn, principal, workspaceId } = await owner();
    await conn.db.deleteFrom("backup_settings").execute();
    const services = await testServices();
    const status = await runOperation(
      principal,
      backupsSetPassphrase,
      { passphrase: PASSPHRASE },
      { db: conn, services, now: () => NOW },
    );
    // The request only starts the derivation. The key is not in use yet.
    expect(status).toMatchObject({
      passphraseSet: false,
      changed: false,
      passphraseDerivation: { status: "pending", startedAt: NOW },
    });
    const [job] = services.derivationJobs;
    if (!job) throw new Error("No derivation started.");
    expect(job.segments).toBe(6);
    expect(await finishDerivation(job)).toBe("ready");

    const after = await runOperation(
      principal,
      backupsGet,
      {},
      { db: conn, services, now: () => NOW },
    );
    expect(after).toMatchObject({ passphraseSet: true, passphraseDerivation: { status: "ready" } });
    const stored = await readBackupSettings(conn);
    expect(stored?.kdf_iterations).toBeGreaterThanOrEqual(600_000);
    expect(JSON.stringify(stored)).not.toContain(PASSPHRASE);

    const again = await runOperation(
      principal,
      backupsSetPassphrase,
      { passphrase: `${PASSPHRASE}!` },
      { db: conn, services, now: () => NOW },
    );
    expect(again.changed).toBe(true);
    const audit = await conn.db
      .selectFrom("audit_log")
      .select(["action", "metadata"])
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(audit).toEqual([
      { action: "backups.set_passphrase", metadata: '{"passphrase":"set"}' },
      { action: "backups.set_passphrase", metadata: '{"passphrase":"changed"}' },
    ]);
  });

  it("rejects a passphrase under 12 characters", async () => {
    const { conn, principal } = await owner();
    const error = await rejection(
      runOperation(
        principal,
        backupsSetPassphrase,
        { passphrase: "eleven char" },
        { db: conn, now: () => NOW },
      ),
    );
    expect(isOperationError(error) && error.code).toBe("invalid_input");
    expect(JSON.stringify((error as { details: unknown }).details)).toContain("12 characters");
  });

  it("refuses a session whose sign-in is older than 10 minutes", async () => {
    for (const signedInAt of [NOW - RECENT_SIGN_IN_MS - 1, null]) {
      const { conn, principal } = await owner(signedInAt);
      const cases: [Operation, unknown][] = [
        [backupsSetPassphrase, { passphrase: PASSPHRASE }],
        [backupsUpdateSettings, { s3: S3_INPUT }],
        [backupsStart, {}],
      ];
      for (const [operation, input] of cases) {
        const error = await rejection(
          runOperation(principal, operation, input, { db: conn, now: () => NOW }),
        );
        expect(isOperationError(error) && error.code).toBe("forbidden");
        expect((error as { details: unknown }).details).toEqual({ code: "SESSION_NOT_FRESH" });
      }
      // Reading the status needs no fresh sign-in.
      await expect(
        runOperation(principal, backupsGet, {}, { db: conn, now: () => NOW }),
      ).resolves.toBeDefined();
    }
  });

  it("is owner only: an API key with every key scope cannot use any backup operation", async () => {
    const { conn, workspaceId } = await owner();
    const created = await createApiKey(conn, workspaceId, API_KEY_SCOPES);
    const principal = await resolveApiKey(conn, created.key, { surface: "rest" });
    if (!principal) throw new Error("The key did not resolve.");
    const cases: [Operation, unknown][] = [
      [backupsGet, {}],
      [backupsRuns, {}],
      [backupsStart, {}],
      [backupsSetPassphrase, { passphrase: PASSPHRASE }],
      [backupsUpdateSettings, { enabled: false }],
    ];
    for (const [operation, input] of cases) {
      const error = await rejection(runOperation(principal, operation, input, { db: conn }));
      expect(isOperationError(error) && error.code).toBe("forbidden");
    }
  });

  it("is in the registry with the session-only scope and never through MCP", () => {
    for (const id of [
      "backups.get",
      "backups.runs",
      "backups.start",
      "backups.set_passphrase",
      "backups.update_settings",
    ]) {
      const operation = registry.get(id);
      expect(operation?.scope).toBe("workspace:admin");
      expect(operation?.mcp.class).toBe("never");
      expect(operation?.mcp.reason.length).toBeGreaterThan(20);
    }
  });

  it("stores the S3 destination encrypted, never returns the secret, and audits the change", async () => {
    const { conn, principal, workspaceId } = await owner();
    const services = await testServices();
    const status = await runOperation(
      principal,
      backupsUpdateSettings,
      { retentionDays: 30, s3: { ...S3_INPUT, endpoint: "https://s3.example.test/" } },
      { db: conn, services, now: () => NOW },
    );
    expect(status.retentionDays).toBe(30);
    expect(status.s3).toEqual({
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      bucket: "envelopen-backups",
      accessKeyId: "AKIDEXAMPLE",
    });
    expect(JSON.stringify(status)).not.toContain(S3_INPUT.secretAccessKey);
    const stored = await readBackupSettings(conn);
    expect(stored?.s3_config).not.toContain(S3_INPUT.secretAccessKey);
    // Another key cannot read it.
    const other = await createCredentialCipher([{ version: 1, secret: btoa("x".repeat(32)) }]);
    expect(
      await rejection(
        other.decrypt(stored?.s3_config ?? "", 1, {
          workspaceId: 0,
          purpose: "backup_destination",
          connectionId: 1,
        }),
      ),
    ).toBeInstanceOf(Error);

    await runOperation(
      principal,
      backupsUpdateSettings,
      { s3: null },
      { db: conn, services, now: () => NOW },
    );
    expect((await readBackupSettings(conn))?.s3_config).toBeNull();
    const audit = await conn.db
      .selectFrom("audit_log")
      .select(["action", "metadata"])
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(audit).toEqual([
      {
        action: "backups.update_settings",
        metadata: JSON.stringify({
          retentionDays: 30,
          s3: "set",
          s3Endpoint: "s3.example.test",
          s3Bucket: "envelopen-backups",
        }),
      },
      { action: "backups.update_settings", metadata: '{"s3":"removed"}' },
    ]);
    expect(JSON.stringify(audit)).not.toContain(S3_INPUT.secretAccessKey);
    await writeBackupSettings(conn, { retention_days: 14 }, NOW);
  });

  it("rejects an S3 endpoint that is not https", async () => {
    const { conn, principal } = await owner();
    const error = await rejection(
      runOperation(
        principal,
        backupsUpdateSettings,
        { s3: { ...S3_INPUT, endpoint: "http://s3.example.test" } },
        { db: conn, now: () => NOW },
      ),
    );
    expect(isOperationError(error) && error.code).toBe("invalid_input");
  });

  it("starts a manual backup, refuses a second one while it runs, and lists the runs", async () => {
    const { conn, principal } = await owner();
    await conn.db
      .updateTable("backup_runs")
      .set({ status: "failed" })
      .where("status", "=", "running")
      .execute();
    await setPassphrase();
    const services = await testServices();
    const run = await runOperation(
      principal,
      backupsStart,
      {},
      { db: conn, services, now: () => NOW },
    );
    expect(run).toMatchObject({ status: "running", trigger: "manual" });
    expect(services.backupJobs).toEqual([{ runId: run.id, backupId: run.backupId }]);
    const error = await rejection(
      runOperation(principal, backupsStart, {}, { db: conn, services, now: () => NOW }),
    );
    expect(isOperationError(error) && error.code).toBe("conflict");
    const runs = await runOperation(principal, backupsRuns, {}, { db: conn });
    expect(runs.items[0]).toMatchObject({ id: run.id, status: "running" });
    const status = await runOperation(
      principal,
      backupsGet,
      {},
      { db: conn, services, now: () => NOW },
    );
    expect(status).toMatchObject({
      passphraseSet: true,
      lastRun: { id: run.id },
      readBudget: 2_000_000,
    });
    expect(status.nextRunAt).toBeGreaterThan(NOW);
    await conn.db
      .updateTable("backup_runs")
      .set({ status: "failed" })
      .where("id", "=", run.id)
      .execute();
  });
});
