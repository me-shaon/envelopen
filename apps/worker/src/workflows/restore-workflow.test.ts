import { createExecutionContext, introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  API_KEY_SCOPES,
  ARCHIVE_MAGIC,
  type BackupDeps,
  backupSteps,
  createCredentialCipher,
  createEmailHasher,
  createKeyMaterial,
  createPinnedEmailHasher,
  driveBackup,
  generateApiKey,
  normalizeEmail,
  parseManifest,
  RESTORE_ORDER,
  readArchiveHeader,
  startBackup,
  writeBackupSettings,
} from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { createTokenSigner } from "@envelopen/email-render";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  cookiesFrom,
  createOwner,
  freshIp,
  OWNER,
  SETUP_TOKEN,
  signIn,
  testEnv,
} from "../../test/auth-helpers";
import { RESTORE_PASSPHRASE_KEY } from "../auth/rate-limit-do";
import { runCron } from "../cron";
import worker from "../index";
import { createServices, forgetImportedSigningKeys, tokenSigner } from "../services";

// Restore end to end in the local runtime (U5, KTD3): a backup of this deployment, made
// with other secrets, goes back into the same D1 after every row is gone, as a
// re-deploy to the same account would. The first-run routes start a real restore
// Workflow. The core test (packages/core/src/backup/restore.test.ts) covers the engine.

const PASSPHRASE = "a long backup passphrase";
const SOURCE_SIGNING_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(21)));
const SOURCE_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(22)));
const SUPPRESSED = "gone@example.org";
const WORKSPACE_HEADER = "X-Envelopen-Workspace";

// The routes and the Workflow must use the same keys: the derivation seals the
// passphrase with ENCRYPTION_KEY, and the Workflow opens it.
const E = testEnv({ SIGNING_KEY: env.SIGNING_KEY, ENCRYPTION_KEY: env.ENCRYPTION_KEY });
const db = () => createDb(env);

/** Deletes every row, as in a new deployment. R2 keeps the backups. */
async function wipe() {
  const tables = [
    "restore_tables",
    "restore_runs",
    "key_derivations",
    "auth_session",
    "backup_runs",
    ...[...RESTORE_ORDER].reverse(),
  ];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
}

interface Source {
  backupId: string;
  workspaceId: number;
  connectionId: number;
  suppressionHash: string;
}

/** Seeds an owner, contacts, a connection, and a suppression with the source secrets. */
async function backUpSource(): Promise<Source> {
  await wipe();
  const owner = await createOwner({ env: E });
  const conn = db();
  const workspaceId = owner.workspaceId;
  const list = await conn.db
    .insertInto("lists")
    .values({ workspace_id: workspaceId, name: "Students", description: null })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (let i = 0; i < 5; i++) {
    const contact = await conn.db
      .insertInto("contacts")
      .values({
        workspace_id: workspaceId,
        email: `student${i}@example.org`,
        first_name: null,
        last_name: null,
        consent_basis: "explicit_opt_in",
        consent_source: "test",
        consent_at: Date.now(),
        source: "test",
        email_hash: null,
        unsubscribed_at: null,
        unsubscribe_source: null,
        unsubscribe_campaign_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await conn.db
      .insertInto("list_members")
      .values({
        workspace_id: workspaceId,
        list_id: list.id,
        contact_id: contact.id,
        status: "subscribed",
        status_source: "test",
        status_at: Date.now(),
        status_campaign_id: null,
      })
      .execute();
  }
  const sourceCipher = await createCredentialCipher([
    { version: 1, secret: SOURCE_ENCRYPTION_KEY },
  ]);
  const connection = await conn.db
    .insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider: "resend",
      name: "Resend",
      policy: "campaign",
      credentials_encrypted: "pending",
      credentials_key_version: 1,
      webhook_secret_encrypted: null,
      events_setup: "none",
      provider_refs: "{}",
      status: "active",
      status_detail: null,
      policy_warning_accepted_at: null,
      policy_warning_accepted_by: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await conn.db
    .updateTable("provider_connections")
    .set({
      credentials_encrypted: await sourceCipher.encrypt(JSON.stringify({ apiKey: "re_source" }), {
        workspaceId,
        purpose: "credentials",
        connectionId: connection.id,
      }),
    })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", connection.id)
    .execute();
  await createPinnedEmailHasher(env.DB, [SOURCE_SIGNING_KEY]);
  const suppressionHash = await (await createEmailHasher(SOURCE_SIGNING_KEY))(
    normalizeEmail(SUPPRESSED) as string,
  );
  await conn.db
    .insertInto("suppressions")
    .values({
      workspace_id: workspaceId,
      email_hash: suppressionHash,
      reason: "manual",
      source: "test",
      campaign_id: null,
    })
    .execute();
  const material = await createKeyMaterial(PASSPHRASE, { iterations: 1000 });
  await writeBackupSettings(
    conn,
    {
      public_key: material.publicKey,
      kdf_salt: material.kdfSalt,
      kdf_iterations: material.kdfIterations,
      verifier: material.verifier,
      verifier_salt: material.verifierSalt,
      verifier_iterations: material.verifierIterations,
      key_set_at: Date.now(),
    },
    Date.now(),
  );

  const jobs: { runId: number; backupId: string }[] = [];
  await startBackup(conn, async (job) => void jobs.push(job), "manual", Date.now());
  const job = jobs[0];
  if (!job) throw new Error("No backup job.");
  const deps = (work: (deps: BackupDeps) => Promise<unknown>) =>
    work({
      db: db(),
      bucket: env.BUCKET,
      credentials: sourceCipher,
      outboundFetch: fetch,
      secrets: { signingKey: SOURCE_SIGNING_KEY, encryptionKey: SOURCE_ENCRYPTION_KEY },
      now: Date.now(),
    });
  const result = await driveBackup(
    { step: (_name, work) => work(), sleepUntil: async () => {} },
    backupSteps(deps, job),
  );
  expect(result).toBe("succeeded");
  return { backupId: job.backupId, workspaceId, connectionId: connection.id, suppressionHash };
}

/** Starts a restore through the route and waits for its Workflow instance. */
async function restoreThroughRoute(body: Record<string, unknown>, ip = freshIp()) {
  const introspector = await introspectWorkflow(env.RESTORE_WORKFLOW);
  try {
    const res = await call("/api/setup/restore/start", {
      env: E,
      ip,
      body: { token: SETUP_TOKEN, ...body },
    });
    if (res.status !== 202) return { res, instances: 0 };
    const instances = await introspector.get();
    for (const instance of instances) await instance.waitForStatus("complete");
    return { res, instances: instances.length };
  } finally {
    await introspector.dispose();
  }
}

async function restoreStatus(ip = freshIp()) {
  const res = await call("/api/setup/restore/status", { env: E, ip, body: { token: SETUP_TOKEN } });
  return { res, body: (await res.json()) as { restore: Record<string, unknown> | null } };
}

let source: Source;
/** The archive that the download test got, for the upload test. */
let downloaded: Uint8Array | null = null;

beforeAll(async () => {
  source = await backUpSource();
});

afterEach(() => {
  forgetImportedSigningKeys();
});

describe("restore from the first-run screen", () => {
  it("lists the backups in R2 and refuses a wrong passphrase before any data row", async () => {
    await wipe();
    await env.AUTH_RATE_LIMITER.getByName(RESTORE_PASSPHRASE_KEY).reset();
    const sources = await call("/api/setup/restore/sources", {
      env: E,
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    expect(sources.status).toBe(200);
    const listed = (await sources.json()) as { backups: { backupId: string; problem: unknown }[] };
    expect(listed.backups.map((b) => b.backupId)).toContain(source.backupId);

    const wrong = await restoreThroughRoute({
      source: { kind: "r2", backupId: source.backupId },
      passphrase: "not the right passphrase",
    });
    expect(wrong.res.status).toBe(202);
    expect(wrong.instances).toBe(1);
    const { body } = await restoreStatus();
    expect(body.restore).toMatchObject({ status: "failed", errorCode: "wrong_passphrase" });
    const rows = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM workspaces) + (SELECT COUNT(*) FROM contacts) AS n",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("locks every restore start after five wrong passphrases", async () => {
    await wipe();
    const limiter = env.AUTH_RATE_LIMITER.getByName(RESTORE_PASSPHRASE_KEY);
    await limiter.reset();
    for (let i = 0; i < 5; i++) {
      await limiter.record({ limit: 5, windowMs: 60 * 60 * 1000 });
    }
    const res = await call("/api/setup/restore/start", {
      env: E,
      ip: freshIp(),
      body: {
        token: SETUP_TOKEN,
        source: { kind: "r2", backupId: source.backupId },
        passphrase: PASSPHRASE,
      },
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("restore_locked");
    await limiter.reset();
  });

  it("refuses a wrong setup token and a short passphrase", async () => {
    await wipe();
    const wrong = await call("/api/setup/restore/start", {
      env: E,
      ip: freshIp(),
      body: {
        token: "wrong",
        source: { kind: "r2", backupId: source.backupId },
        passphrase: PASSPHRASE,
      },
    });
    expect(wrong.status).toBe(401);
    const short = await call("/api/setup/restore/start", {
      env: E,
      ip: freshIp(),
      body: {
        token: SETUP_TOKEN,
        source: { kind: "r2", backupId: source.backupId },
        passphrase: "short",
      },
    });
    expect(short.status).toBe(400);
  });

  it("restores into the empty deployment with its own keys, then closes the screen", async () => {
    await wipe();
    await env.AUTH_RATE_LIMITER.getByName(RESTORE_PASSPHRASE_KEY).reset();
    const done = await restoreThroughRoute({
      source: { kind: "r2", backupId: source.backupId },
      passphrase: PASSPHRASE,
    });
    expect(done.res.status).toBe(202);
    const { body } = await restoreStatus();
    expect(body.restore).toMatchObject({ status: "succeeded", rowsSkipped: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first("n")).toBe(5);
    expect(
      await env.DB.prepare("SELECT subscribed_count FROM lists").first("subscribed_count"),
    ).toBe(5);

    // The owner exists again, so setup and a second restore are refused.
    const check = await call("/api/setup/check", {
      env: E,
      ip: freshIp(),
      body: { token: SETUP_TOKEN },
    });
    expect(check.status).toBe(404);
    const again = await call("/api/setup/restore/start", {
      env: E,
      ip: freshIp(),
      body: {
        token: SETUP_TOKEN,
        source: { kind: "r2", backupId: source.backupId },
        passphrase: PASSPHRASE,
      },
    });
    expect(again.status).toBe(404);

    // No session came back: the owner signs in again with the password.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_session").first("n")).toBe(0);
    const signed = await signIn(OWNER.password, { env: E });
    expect(signed.status).toBe(200);

    // The token signer and the suppression hasher read the imported key.
    const services = createServices(env);
    const oldToken = await (await createTokenSigner([{ secret: SOURCE_SIGNING_KEY }])).sign({
      campaignId: 7,
      recipientId: 70,
    });
    expect(await (await tokenSigner(env)).verify(oldToken)).toMatchObject({
      campaignId: 7,
      recipientId: 70,
      retired: true,
    });
    expect(await services.hashEmail?.(normalizeEmail(SUPPRESSED) as string)).toBe(
      source.suppressionHash,
    );
    // The credentials decrypt with this deployment's ENCRYPTION_KEY.
    const row = await env.DB.prepare(
      "SELECT credentials_encrypted, credentials_key_version FROM provider_connections WHERE id = ?",
    )
      .bind(source.connectionId)
      .first<{ credentials_encrypted: string; credentials_key_version: number }>();
    if (!row || !services.credentials) throw new Error("No connection.");
    expect(
      await services.credentials.decrypt(row.credentials_encrypted, row.credentials_key_version, {
        workspaceId: source.workspaceId,
        purpose: "credentials",
        connectionId: source.connectionId,
      }),
    ).toBe(JSON.stringify({ apiKey: "re_source" }));

    // Sends wait for the owner, who sees the restore in the backup status.
    const cookie = cookiesFrom(signed);
    const status = await call("/api/backups", {
      env: E,
      headers: { cookie, [WORKSPACE_HEADER]: String(source.workspaceId) },
    });
    expect(((await status.json()) as { restore: unknown }).restore).toMatchObject({
      backupId: source.backupId,
    });
  });
});

describe("backup download", () => {
  async function ownerCookie() {
    const signed = await signIn(OWNER.password, { env: E });
    expect(signed.status).toBe(200);
    return cookiesFrom(signed);
  }

  async function newBackupRun(): Promise<number> {
    const services = createServices(env);
    const jobs: { runId: number; backupId: string }[] = [];
    await db()
      .db.updateTable("backup_runs")
      .set({ status: "failed" })
      .where("status", "=", "running")
      .execute();
    const run = await startBackup(db(), async (job) => void jobs.push(job), "manual", Date.now());
    const job = jobs[0];
    if (!job) throw new Error("No backup job.");
    const deps = (work: (deps: BackupDeps) => Promise<unknown>) =>
      work({
        db: db(),
        bucket: env.BUCKET,
        credentials: services.credentials,
        outboundFetch: fetch,
        secrets: { signingKey: env.SIGNING_KEY, encryptionKey: env.ENCRYPTION_KEY },
        now: Date.now(),
      });
    await driveBackup(
      { step: (_n, work) => work(), sleepUntil: async () => {} },
      backupSteps(deps, job),
    );
    return run.id;
  }

  it("streams the archive through a short-lived link after a recent sign-in", async () => {
    const runId = await newBackupRun();
    const cookie = await ownerCookie();
    const res = await call(`/api/backups/runs/${runId}/download`, {
      env: E,
      headers: { cookie, [WORKSPACE_HEADER]: String(source.workspaceId) },
      body: {},
    });
    expect(res.status).toBe(200);
    const link = (await res.json()) as { url: string; sizeBytes: number; filename: string };
    const file = await call(link.url, { env: E });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain(".envbak");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe(ARCHIVE_MAGIC);
    const length = readArchiveHeader(bytes);
    const manifest = parseManifest(bytes.subarray(12, 12 + length));
    expect(bytes.length).toBe(12 + length + manifest.chunks.reduce((sum, c) => sum + c.bytes, 0));
    const audit = await env.DB.prepare(
      "SELECT target_id FROM audit_log WHERE action = 'backups.download' ORDER BY id DESC",
    ).first<{ target_id: string }>();
    expect(audit?.target_id).toBe(String(runId));
    downloaded = bytes;
  });

  it("refuses an old session and an API key", async () => {
    const runId = await newBackupRun();
    const cookie = await ownerCookie();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    const stored = await env.DB.prepare('SELECT "createdAt" AS at FROM auth_session').first<{
      at: unknown;
    }>();
    await env.DB.prepare('UPDATE auth_session SET "createdAt" = ?')
      .bind(typeof stored?.at === "number" ? old.getTime() : old.toISOString())
      .run();
    const stale = await call(`/api/backups/runs/${runId}/download`, {
      env: E,
      headers: { cookie, [WORKSPACE_HEADER]: String(source.workspaceId) },
      body: {},
    });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: { details: unknown } }).error.details).toEqual({
      code: "SESSION_NOT_FRESH",
    });

    const generated = await generateApiKey();
    await env.DB.prepare(
      "INSERT INTO api_keys (workspace_id, name, prefix, key_hash, scopes) VALUES (?, 'All', ?, ?, ?)",
    )
      .bind(source.workspaceId, generated.prefix, generated.keyHash, JSON.stringify(API_KEY_SCOPES))
      .run();
    const keyed = await call(`/api/backups/runs/${runId}/download`, {
      env: E,
      headers: { authorization: `Bearer ${generated.key}` },
      body: {},
      origin: null,
    });
    expect(keyed.status).toBe(403);
  });
});

describe("restore of an uploaded archive", () => {
  async function post(bytes: Uint8Array): Promise<Response> {
    const request = new Request("https://envelopen.test/api/setup/restore/upload", {
      method: "POST",
      headers: {
        "x-setup-token": SETUP_TOKEN,
        "content-length": String(bytes.length),
        "cf-connecting-ip": freshIp(),
        origin: "https://envelopen.test",
      },
      body: bytes,
    });
    return worker.fetch(request, E, createExecutionContext());
  }

  it("refuses an upload once the owner exists, and restores the file into a new deployment", async () => {
    if (!downloaded) throw new Error("The download test did not run.");
    expect((await post(downloaded)).status).toBe(404);

    await wipe();
    await env.AUTH_RATE_LIMITER.getByName(RESTORE_PASSPHRASE_KEY).reset();
    const garbage = await post(new TextEncoder().encode("not a backup file at all"));
    expect(garbage.status).toBe(400);
    const stored = await post(downloaded);
    expect(stored.status).toBe(201);
    const { uploadId, backup } = (await stored.json()) as {
      uploadId: string;
      backup: { totalRows: number; problem: string | null; estimatedDays: number };
    };
    expect(backup).toMatchObject({ problem: null, estimatedDays: 1 });
    const done = await restoreThroughRoute({
      source: { kind: "upload", uploadId },
      passphrase: PASSPHRASE,
    });
    expect(done.res.status).toBe(202);
    const { body } = await restoreStatus();
    expect(body.restore).toMatchObject({ status: "succeeded", source: "upload" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first("n")).toBe(5);
    // The uploaded file is gone after the restore.
    const left = await env.BUCKET.list({ prefix: "restore-uploads/" });
    expect(left.objects).toHaveLength(0);
  });
});

describe("while a restore runs", () => {
  it("the cron waits and the owner form is refused", async () => {
    await wipe();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO restore_runs (status, source, source_key, backup_id, backup_created_at, schema_version, total_rows, chunk_count, started_at, updated_at) VALUES ('running', 'r2', ?, ?, ?, 17, 10, 1, ?, ?)",
    )
      .bind(source.backupId, source.backupId, now, now, now)
      .run();
    const report = await runCron(env, createExecutionContext(), now);
    expect(report.restoring).toBe(true);
    const owner = await call("/api/setup/owner", {
      env: E,
      ip: freshIp(),
      body: {
        token: SETUP_TOKEN,
        email: OWNER.email,
        name: OWNER.name,
        workspaceName: OWNER.workspaceName,
        password: OWNER.password,
      },
    });
    expect(owner.status).toBe(409);
    expect(((await owner.json()) as { error: { code: string } }).error.code).toBe(
      "restore_running",
    );
    await wipe();
  });
});
