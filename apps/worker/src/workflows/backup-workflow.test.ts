import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  backupPrefix,
  createKeyMaterial,
  decodeRows,
  decryptChunk,
  MANIFEST_KEY,
  type Manifest,
  nextBackupAt,
  readBackupSettings,
  startKeyDerivation,
  unwrap,
  verifyManifest,
  writeBackupSettings,
} from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackupCron } from "../cron";
import { backupStarter, createServices, keyDerivationStarter } from "../services";

// The backup Workflow end to end, in the local runtime: the cron starts a real Workflow
// run with no owner present, and the run wraps the data key to the stored public key.

const PASSPHRASE = "a long backup passphrase";
const db = () => createDb(env);

async function reset() {
  await db().db.deleteFrom("backup_runs").execute();
  await db().db.deleteFrom("backup_settings").execute();
}

async function setPassphrase() {
  // Low PBKDF2 costs keep the test fast. The engine reads the costs from the row.
  const material = await createKeyMaterial(PASSPHRASE, { iterations: 1000 });
  await writeBackupSettings(
    db(),
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
  return material;
}

function cronDeps() {
  const services = createServices(env);
  return {
    db: db(),
    bucket: env.BUCKET,
    credentials: services.credentials,
    outboundFetch: services.outboundFetch ?? fetch,
    startBackupJob: backupStarter(env),
  };
}

/** Runs `action`, then waits for every backup Workflow instance that it started. */
async function waitForRuns(action: () => Promise<void>, options: { noSleeps?: boolean } = {}) {
  const introspector = await introspectWorkflow(env.BACKUP_WORKFLOW);
  try {
    if (options.noSleeps) {
      await introspector.modifyAll(async (m) => {
        await m.disableSleeps();
      });
    }
    await action();
    const instances = await introspector.get();
    expect(instances.length).toBe(1);
    for (const instance of instances) await instance.waitForStatus("complete");
  } finally {
    await introspector.dispose();
  }
}

async function lastRun() {
  return db()
    .db.selectFrom("backup_runs")
    .selectAll()
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
}

async function manifestOf(backupId: string): Promise<Manifest> {
  const object = await env.BUCKET.get(backupPrefix(backupId) + MANIFEST_KEY);
  if (!object) throw new Error("No manifest.");
  return (await object.json()) as Manifest;
}

beforeEach(reset);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("key derivation Workflow", () => {
  it("derives the passphrase key in steps and stores the same key as the one-shot form", async () => {
    const services = createServices(env);
    if (!services.credentials) throw new Error("ENCRYPTION_KEY is missing in the test env.");
    const salt = new Uint8Array(16).fill(6);
    const verifierSalt = new Uint8Array(16).fill(7);
    const introspector = await introspectWorkflow(env.KEY_DERIVATION_WORKFLOW);
    try {
      const job = await startKeyDerivation(
        db(),
        services.credentials,
        keyDerivationStarter(env),
        { purpose: "setup", passphrase: PASSPHRASE, salt, verifierSalt },
        Date.now(),
      );
      expect(job.segments).toBe(6);
      const [instance] = await introspector.get();
      if (!instance) throw new Error("No Workflow instance.");
      for (let index = 1; index <= 6; index++) {
        // Each step runs one segment of at most 100,000 iterations.
        expect(await instance.waitForStepResult({ name: `segment ${index}` })).toEqual({
          kind: "done",
          iterations: 100_000,
        });
      }
      await instance.waitForStatus("complete");
    } finally {
      await introspector.dispose();
    }
    const oneShot = await createKeyMaterial(PASSPHRASE, { salt, verifierSalt });
    expect(await readBackupSettings(db())).toMatchObject({
      public_key: oneShot.publicKey,
      verifier: oneShot.verifier,
      kdf_iterations: 600_000,
    });
    const rows = await db().db.selectFrom("key_derivations").selectAll().execute();
    expect(rows.at(-1)).toMatchObject({ status: "ready", sealed_secret: null, sealed_state: null });
  });
});

describe("backup Workflow", () => {
  it("runs the scheduled backup with no owner present, wrapped to the stored public key", async () => {
    const material = await setPassphrase();
    await db().db.insertInto("workspaces").values({ name: "Backed up" }).execute();
    await waitForRuns(async () => {
      const report = await runBackupCron(cronDeps(), Date.now());
      expect(report.skipped).toBeNull();
      expect(report.started).toEqual(expect.any(String));
    });
    const run = await lastRun();
    expect(run).toMatchObject({ status: "succeeded", trigger: "schedule", destinations: '["r2"]' });

    const manifest = await manifestOf(run.backup_id);
    expect(manifest.keyMaterial).toEqual(material);
    // Only the passphrase opens it. The secrets are the Worker's own.
    const opened = await unwrap(
      manifest.wrappedKey,
      manifest.backupId,
      PASSPHRASE,
      manifest.keyMaterial,
    );
    await verifyManifest(manifest, opened.dataKey);
    expect(opened.secrets.signingKey).toBe(env.SIGNING_KEY);
    expect(opened.secrets.encryptionKey).toBe(env.ENCRYPTION_KEY);
    const chunk = manifest.chunks.find((c) => c.table === "workspaces");
    if (!chunk) throw new Error("No workspaces chunk.");
    const object = await env.BUCKET.get(backupPrefix(manifest.backupId) + chunk.key);
    const rows = decodeRows(
      await decryptChunk(
        opened.dataKey,
        manifest.backupId,
        chunk.index,
        new Uint8Array(await (object as R2ObjectBody).arrayBuffer()),
      ),
    );
    expect(rows.map((row) => row.name)).toContain("Backed up");
  });

  it("sleeps over a spent read budget and resumes after the reset", async () => {
    await setPassphrase();
    const today = new Date().toISOString().slice(0, 10);
    // An earlier run of today used the whole budget.
    await db()
      .db.insertInto("backup_runs")
      .values({
        backup_id: "earlier",
        trigger: "manual",
        status: "succeeded",
        started_at: Date.now() - 60_000,
        read_day: today,
        rows_read_day: 2_000_000,
      })
      .execute();
    await waitForRuns(
      async () => {
        await runBackupCron(cronDeps(), Date.now());
      },
      { noSleeps: true },
    );
    const run = await lastRun();
    expect(run.status).toBe("succeeded");
    // The chunks were read on the next UTC day, not today.
    expect(run.read_day).not.toBe(today);
    expect(run.rows_read_day).toBeGreaterThan(0);
  });

  it("records a partial run when the S3 copy fails", async () => {
    await setPassphrase();
    const services = createServices(env);
    if (!services.credentials) throw new Error("ENCRYPTION_KEY is missing in the test env.");
    await writeBackupSettings(
      db(),
      {
        s3_config: await services.credentials.encrypt(
          JSON.stringify({
            endpoint: "https://s3.example.test",
            region: "auto",
            bucket: "backups",
            accessKeyId: "AKID",
            secretAccessKey: "secret-key-value",
          }),
          { workspaceId: 0, purpose: "backup_destination", connectionId: 1 },
        ),
        s3_key_version: 1,
      },
      Date.now(),
    );
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      urls.push(new Request(input, init).url);
      return new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 });
    });
    await waitForRuns(async () => {
      await runBackupCron(cronDeps(), Date.now());
    });
    const run = await lastRun();
    expect(run).toMatchObject({ status: "partial", destinations: '["r2"]' });
    expect(run.s3_error).toContain("HTTP 503 (SlowDown)");
    expect(urls[0]).toMatch(/^https:\/\/s3\.example\.test\/backups\/backups\//);
    await expect(manifestOf(run.backup_id)).resolves.toMatchObject({ backupId: run.backup_id });
  });

  it("skips the daily run without a passphrase or when backups are off", async () => {
    expect(await runBackupCron(cronDeps(), Date.now())).toMatchObject({
      started: null,
      skipped: "no passphrase",
    });
    await setPassphrase();
    await writeBackupSettings(db(), { enabled: 0 }, Date.now());
    expect(await runBackupCron(cronDeps(), Date.now())).toMatchObject({
      started: null,
      skipped: "disabled",
    });
    expect(await db().db.selectFrom("backup_runs").selectAll().execute()).toEqual([]);
    expect(nextBackupAt(Date.UTC(2026, 9, 21, 2, 22))).toBe(Date.UTC(2026, 9, 21, 2, 23));
  });
});
