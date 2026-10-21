import { env } from "cloudflare:workers";
import { createDb, TABLE_SCOPE } from "@envelopen/db";
import { createTokenSigner } from "@envelopen/email-render";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { seedCampaignWorkspace, seedSentCampaign } from "../../test/campaign-fixtures";
import {
  createApiKey,
  TEST_ENCRYPTION_KEY,
  TEST_SIGNING_KEY,
  testDb,
  testServices,
} from "../../test/fixtures";
import { resolveApiKey } from "../api-keys";
import { dispatchBatches } from "../campaigns/dispatch";
import { campaignsConfirm } from "../campaigns/operations";
import { decryptCredentials } from "../connections/model";
import { normalizeEmail } from "../contacts/email";
import { type CredentialCipher, createCredentialCipher } from "../crypto/credentials";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import type { ImportCounts } from "../import/model";
import { importsCreate, importsGet, importsPreview, importsStart } from "../import/operations";
import { runImportJob } from "../import/process";
import { RECENT_SIGN_IN_MS, sessionPrincipal } from "../principal";
import { registry } from "../registry";
import type { Operation } from "../registry/operation";
import { API_KEY_SCOPES } from "../scopes";
import type { ImportJob, RestoreJob, UsageStatus } from "../services";
import { createPinnedEmailHasher, signingKeyRing } from "../suppression/hash";
import {
  ARCHIVE_MAGIC,
  archiveLinkKey,
  backupIdOfLinkKey,
  RESTORE_UPLOAD_PREFIX,
  readArchiveHeader,
  streamBackupArchive,
} from "./archive";
import { createKeyMaterial } from "./crypto";
import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_TABLES,
  backupPrefix,
  MANIFEST_KEY,
  type Manifest,
} from "./format";
import { writeBackupSettings } from "./model";
import { backupsAcknowledgeRestore, backupsDownload, backupsGet } from "./operations";
import {
  beginRestore,
  driveRestore,
  type RestoreDeps,
  type RestoreRunner,
  readRestoreStatus,
  restoreSteps,
} from "./restore";
import { RESTORE_ACK_SETTING, readRestoreAck } from "./restore-ack";
import {
  DEFERRED_REFERENCES,
  FOREIGN_KEYS,
  RESTORE_ORDER,
  schemaProblem,
  upgradeRow,
} from "./restore-plan";
import { type BackupDeps, backupSteps, driveBackup, startBackup } from "./run";
import { readImportedSigningKeys } from "./signing-keys";

// Restore (U5, KTD3, R3): a backup of the test deployment (env.DB) goes into a second,
// fresh deployment (env.RESTORE_DB) with other secrets. The Workflow test
// (apps/worker/src/workflows/restore-workflow.test.ts) runs the same driver as steps.

const PASSPHRASE = "a long backup passphrase";
const NOW = Date.UTC(2026, 9, 21, 9, 0);
const TARGET_SIGNING_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const TARGET_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
const SUPPRESSED = "Left.Long.Ago@Example.org";

const source = () => createDb(env);
const target = () => createDb({ DB: env.RESTORE_DB });

let targetCipher: Promise<CredentialCipher> | undefined;
function cipherOfTarget(): Promise<CredentialCipher> {
  targetCipher ??= createCredentialCipher([{ version: 1, secret: TARGET_ENCRYPTION_KEY }]);
  return targetCipher;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail.");
}

// The source deployment ---------------------------------------------------------------------

interface Seeded {
  workspaceId: number;
  userId: string;
  connectionId: number;
  listId: number;
  campaignId: number;
  recipientId: number;
  suppressionHash: string;
}

let seeded: Promise<Seeded> | undefined;

/** One owner, a sent campaign with stats, and a suppression. Seeded once per file. */
function seedSource(): Promise<Seeded> {
  seeded ??= (async () => {
    const conn = source();
    const services = await testServices();
    const hasher = await createPinnedEmailHasher(env.DB, [TEST_SIGNING_KEY]);
    const workspace = await seedCampaignWorkspace(
      conn,
      { credentials: services.credentials, hashEmail: hasher },
      { contacts: 12, name: "Source" },
    );
    const sent = await seedSentCampaign(conn, workspace, { startedAt: NOW - 86_400_000 });
    const tag = await conn.db
      .insertInto("tags")
      .values({ workspace_id: workspace.workspaceId, name: "alumni" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const contacts = await conn.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspace.workspaceId)
      .limit(3)
      .execute();
    for (const contact of contacts) {
      await conn.db
        .insertInto("contact_tags")
        .values({ workspace_id: workspace.workspaceId, contact_id: contact.id, tag_id: tag.id })
        .execute();
    }
    // A multiple choice field (U7) with options and one contact's value.
    await conn.db
      .insertInto("contact_fields")
      .values({
        workspace_id: workspace.workspaceId,
        key: "interests",
        label: "Interests",
        kind: "multi",
      })
      .execute();
    const field = await conn.db
      .selectFrom("contact_fields")
      .select("id")
      .where("workspace_id", "=", workspace.workspaceId)
      .where("key", "=", "interests")
      .executeTakeFirstOrThrow();
    const options = await conn.db
      .insertInto("contact_field_options")
      .values(
        ["Design", "Data", "Writing"].map((label, position) => ({
          workspace_id: workspace.workspaceId,
          field_id: field.id,
          label,
          position,
        })),
      )
      .returning("id")
      .execute();
    await conn.db
      .insertInto("contact_field_values")
      .values({
        workspace_id: workspace.workspaceId,
        contact_id: contacts[0]?.id as number,
        field_id: field.id,
        value: JSON.stringify([options[0]?.id, options[2]?.id]),
      })
      .execute();
    const suppressionHash = await hasher(normalizeEmail(SUPPRESSED) as string);
    await conn.db
      .insertInto("suppressions")
      .values({
        workspace_id: workspace.workspaceId,
        email_hash: suppressionHash,
        reason: "manual",
        source: "test",
        campaign_id: null,
      })
      .execute();
    // The owner, as the first-run screen writes it, with a sign-in account and a session.
    await conn.d1
      .prepare(
        "INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', ?, 1, ?, ?)",
      )
      .bind(workspace.userId, `${workspace.userId}@example.com`, NOW, NOW)
      .run();
    await conn.d1
      .prepare(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), NOW + 86_400_000, crypto.randomUUID(), NOW, NOW, workspace.userId)
      .run();
    await conn.db
      .insertInto("system_settings")
      .values({ key: "owner_user_id", value: workspace.userId })
      .onConflict((oc) => oc.column("key").doNothing())
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
        key_set_at: NOW,
      },
      NOW,
    );
    return {
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      connectionId: workspace.connectionId,
      listId: workspace.listId,
      campaignId: sent.campaignId,
      recipientId: sent.recipients[0]?.id ?? 0,
      suppressionHash,
    };
  })();
  return seeded;
}

/** Runs a backup of the source. `onStep` runs after each step. */
async function backUp(onStep?: (name: string) => Promise<void>): Promise<Manifest> {
  await seedSource();
  const services = await testServices();
  const conn = source();
  await conn.db
    .updateTable("backup_runs")
    .set({ status: "failed" })
    .where("status", "=", "running")
    .execute();
  await startBackup(conn, services.startBackupJob, "manual", NOW);
  const job = services.backupJobs.at(-1);
  if (!job) throw new Error("No backup job.");
  const deps = (work: (deps: BackupDeps) => Promise<unknown>) =>
    work({
      db: source(),
      bucket: env.BUCKET,
      credentials: services.credentials,
      outboundFetch: services.outboundFetch,
      secrets: { signingKey: TEST_SIGNING_KEY, encryptionKey: TEST_ENCRYPTION_KEY },
      now: NOW,
    });
  const result = await driveBackup(
    {
      async step(name, work) {
        const value = await work();
        await onStep?.(name);
        return value;
      },
      async sleepUntil() {},
    },
    backupSteps(deps, job),
  );
  expect(result).toBe("succeeded");
  const object = await env.BUCKET.get(backupPrefix(job.backupId) + MANIFEST_KEY);
  if (!object) throw new Error("No manifest.");
  return (await object.json()) as Manifest;
}

// The target deployment ---------------------------------------------------------------------

/** Empties the target, so each test restores into a fresh deployment. */
async function wipeTarget() {
  const db = env.RESTORE_DB;
  const tables = [
    "restore_tables",
    "restore_runs",
    "key_derivations",
    "auth_session",
    "backup_runs",
    ...[...RESTORE_ORDER].reverse(),
  ];
  await db.batch(tables.map((table) => db.prepare(`DELETE FROM "${table}"`)));
}

interface Harness {
  clock: { now: number };
  sleeps: number[];
  steps: string[];
  next: RestoreJob[];
  runner: RestoreRunner;
}

function harness(): Harness {
  const h: Harness = {
    clock: { now: NOW },
    sleeps: [],
    steps: [],
    next: [],
    runner: {
      async step(name, work) {
        h.steps.push(name);
        return work();
      },
      async sleepUntil(_name, until) {
        h.sleeps.push(until);
        h.clock.now = Math.max(h.clock.now, until);
      },
    },
  };
  return h;
}

interface RestoreOptions {
  passphrase?: string;
  source?: "r2" | "upload";
  usage?: () => UsageStatus;
  writeBudget?: number;
  maxSteps?: number;
  manifest?: Manifest;
  onWrongPassphrase?: () => Promise<void>;
}

function depsFactory(h: Harness, options: RestoreOptions) {
  return async <T>(work: (deps: RestoreDeps) => Promise<T>): Promise<T> =>
    work({
      db: target(),
      bucket: env.BUCKET,
      cipher: await cipherOfTarget(),
      encryptionKey: TARGET_ENCRYPTION_KEY,
      signingKey: TARGET_SIGNING_KEY,
      usage: options.usage ? { status: async () => options.usage?.() as UsageStatus } : undefined,
      writeBudget: options.writeBudget,
      onWrongPassphrase: options.onWrongPassphrase,
      now: h.clock.now,
    });
}

/** Stores the archive of a backup as an upload, as the first-run screen does. */
async function uploadArchive(backupId: string): Promise<string> {
  const archive = await streamBackupArchive(env.BUCKET, backupId);
  if (!archive) throw new Error("No archive.");
  const bytes = new Uint8Array(await new Response(archive.body).arrayBuffer());
  expect(bytes.length).toBe(archive.size);
  const key = `${RESTORE_UPLOAD_PREFIX}${crypto.randomUUID()}.envbak`;
  await env.BUCKET.put(key, bytes);
  return key;
}

async function restore(manifest: Manifest, options: RestoreOptions = {}) {
  const h = harness();
  const conn = target();
  const sourceKey =
    options.source === "upload" ? await uploadArchive(manifest.backupId) : manifest.backupId;
  const started = await beginRestore(
    conn,
    await cipherOfTarget(),
    {
      source: options.source ?? "r2",
      sourceKey,
      manifest: options.manifest ?? manifest,
      passphrase: options.passphrase ?? PASSPHRASE,
      ip: "203.0.113.9",
    },
    NOW,
  );
  const deps = depsFactory(h, options);
  const startNext = async (job: RestoreJob) => {
    h.next.push(job);
  };
  let result = await driveRestore(h.runner, restoreSteps(deps, started.job, startNext), {
    maxSteps: options.maxSteps,
  });
  // A long restore goes on in new instances.
  while (result === "continued") {
    const job = h.next.at(-1) as RestoreJob;
    result = await driveRestore(h.runner, restoreSteps(deps, job, startNext), {
      maxSteps: options.maxSteps,
    });
  }
  const run = await conn.db
    .selectFrom("restore_runs")
    .selectAll()
    .where("id", "=", started.runId)
    .executeTakeFirstOrThrow();
  return { h, result, run, sourceKey };
}

async function count(db: D1Database, table: string, where = ""): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const COMPARED = [
  "users",
  "workspaces",
  "contacts",
  "lists",
  "list_members",
  "tags",
  "contact_tags",
  "contact_fields",
  "contact_field_options",
  "contact_field_values",
  "templates",
  "campaigns",
  "campaign_recipients",
  "links",
  "suppressions",
  "campaign_stats_daily",
  "campaign_stats_hourly",
  "workspace_stats_daily",
] as const;

async function dataRows(db: D1Database): Promise<number> {
  let total = 0;
  for (const table of ["users", "auth_user", "workspaces", "contacts", "campaigns"]) {
    total += await count(db, table);
  }
  return total;
}

// Tests ---------------------------------------------------------------------------------------

describe("restore plan", () => {
  it("orders every backed-up table, each after the tables it references", () => {
    expect([...RESTORE_ORDER].sort()).toEqual([...BACKUP_TABLES].sort());
    for (const [index, table] of RESTORE_ORDER.entries()) {
      for (const fk of FOREIGN_KEYS[table] ?? []) {
        const deferred = DEFERRED_REFERENCES.some(
          (item) => item.table === table && item.column === fk.column,
        );
        if (deferred || fk.parent === table) continue;
        expect({
          table,
          parent: fk.parent,
          before: RESTORE_ORDER.indexOf(fk.parent) < index,
        }).toEqual({ table, parent: fk.parent, before: true });
      }
    }
  });

  it("knows every foreign key that the migrations declare", async () => {
    for (const table of Object.keys(TABLE_SCOPE)) {
      if (!BACKUP_TABLES.includes(table as never)) continue;
      const { results } = await env.DB.prepare("SELECT * FROM pragma_foreign_key_list(?)")
        .bind(table)
        .all<{ table: string; from: string; to: string; on_delete: string }>();
      const declared = results
        .map((row) => ({ column: row.from, parent: row.table, parentColumn: row.to }))
        .sort((a, b) => a.column.localeCompare(b.column));
      const known = (FOREIGN_KEYS[table as keyof typeof FOREIGN_KEYS] ?? [])
        .map(({ column, parent, parentColumn }) => ({ column, parent, parentColumn }))
        .sort((a, b) => a.column.localeCompare(b.column));
      expect({ table, keys: known }).toEqual({ table, keys: declared });
      // A required reference or a cascade skips the orphan. An optional one clears it.
      for (const row of results) {
        const fk = FOREIGN_KEYS[table as keyof typeof FOREIGN_KEYS]?.find(
          (item) => item.column === row.from,
        );
        if (row.on_delete === "SET NULL")
          expect({ table, rule: fk?.onMissing }).toEqual({ table, rule: "clear" });
        if (row.on_delete === "CASCADE")
          expect({ table, rule: fk?.onMissing }).toEqual({ table, rule: "skip" });
      }
    }
  });

  it("refuses a newer schema and a schema older than the backup engine", () => {
    expect(schemaProblem(BACKUP_SCHEMA_VERSION)).toBeNull();
    // 16 is the U4 schema. 0017 adds only the restore tables, so the upgrade is identity.
    expect(schemaProblem(16)).toBeNull();
    // 0018 adds contact_fields.kind: a field of an older backup is a plain field.
    expect(schemaProblem(17)).toBeNull();
    expect(upgradeRow("contact_fields", { id: 1, key: "course" }, 17)).toEqual({
      id: 1,
      key: "course",
      kind: null,
    });
    expect(upgradeRow("contacts", { id: 1 }, 16)).toEqual({ id: 1 });
    expect(schemaProblem(BACKUP_SCHEMA_VERSION + 1)).toContain("newer Envelopen");
    expect(schemaProblem(15)).toContain("too old");
  });

  it("reads only real archives", () => {
    expect(() =>
      readArchiveHeader(new TextEncoder().encode("PK\u0003\u0004 not a backup")),
    ).toThrow("not an Envelopen backup");
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode(ARCHIVE_MAGIC));
    new DataView(header.buffer).setUint32(8, 200);
    expect(readArchiveHeader(header)).toBe(200);
    const id = crypto.randomUUID();
    expect(backupIdOfLinkKey(archiveLinkKey(id))).toBe(id);
    expect(backupIdOfLinkKey(`backups/${id}/manifest.json`)).toBeNull();
    expect(backupIdOfLinkKey("exports/1/contacts.csv")).toBeNull();
  });
});

describe("restore into a fresh deployment", () => {
  it("round-trips the data, re-encrypts the credentials, and keeps old links and suppressions", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const s = await seedSource();
    const { result, run } = await restore(manifest);
    expect(result).toBe("succeeded");
    expect(run).toMatchObject({ status: "succeeded", sealed_key: null, error: null });

    // The same rows, up to the marks of the backup.
    for (const table of COMPARED) {
      const mark = manifest.tables.find((t) => t.name === table)?.highWaterMark ?? 0;
      expect({ table, rows: await count(env.RESTORE_DB, table) }).toEqual({
        table,
        rows: await count(env.DB, table, `WHERE rowid <= ${mark}`),
      });
    }
    // The count triggers ran during the inserts and the recount agrees with the source.
    const list = await env.RESTORE_DB.prepare("SELECT subscribed_count FROM lists WHERE id = ?")
      .bind(s.listId)
      .first<{ subscribed_count: number }>();
    expect(list?.subscribed_count).toBe(12);
    const tag = await env.RESTORE_DB.prepare("SELECT contact_count FROM tags LIMIT 1").first<{
      contact_count: number;
    }>();
    expect(tag?.contact_count).toBe(3);
    // Choice fields keep their kind, their options, and the option ids in the values.
    const options = await env.RESTORE_DB.prepare(
      "SELECT o.id, o.label, o.position, f.kind FROM contact_field_options o JOIN contact_fields f ON f.id = o.field_id ORDER BY o.position",
    ).all<{ id: number; label: string; position: number; kind: string }>();
    expect(options.results.map((option) => [option.label, option.position, option.kind])).toEqual([
      ["Design", 0, "multi"],
      ["Data", 1, "multi"],
      ["Writing", 2, "multi"],
    ]);
    const value = await env.RESTORE_DB.prepare(
      "SELECT v.value FROM contact_field_values v JOIN contact_fields f ON f.id = v.field_id WHERE f.key = 'interests'",
    ).first<{ value: string }>();
    expect(value?.value).toBe(JSON.stringify([options.results[0]?.id, options.results[2]?.id]));
    // The deferred reference is set after the connections.
    const workspace = await env.RESTORE_DB.prepare(
      "SELECT sending_connection_id FROM workspaces WHERE id = ?",
    )
      .bind(s.workspaceId)
      .first<{ sending_connection_id: number }>();
    expect(workspace?.sending_connection_id).toBe(s.connectionId);

    // Sessions are not restored, so the owner signs in again. The owner marker is last.
    expect(await count(env.RESTORE_DB, "auth_session")).toBe(0);
    expect(await count(env.RESTORE_DB, "auth_user")).toBeGreaterThan(0);
    const ownerRow = await env.RESTORE_DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'owner_user_id'",
    ).first<{ value: string }>();
    expect(ownerRow?.value).toBe(s.userId);

    // Provider credentials decrypt with this deployment's key, not the backup's.
    const cipher = await cipherOfTarget();
    const connection = await target()
      .db.selectFrom("provider_connections")
      .selectAll()
      .where("workspace_id", "=", s.workspaceId)
      .where("id", "=", s.connectionId)
      .executeTakeFirstOrThrow();
    expect(connection.credentials_encrypted.startsWith("v2.")).toBe(true);
    await expect(decryptCredentials({ credentials: cipher }, connection)).resolves.toEqual({
      apiKey: "re_test_key",
    });

    // The backup's SIGNING_KEY is imported, so a link from a source email verifies.
    const imported = await readImportedSigningKeys(target(), cipher);
    expect(imported).toEqual([TEST_SIGNING_KEY]);
    const ring = signingKeyRing(TARGET_SIGNING_KEY, undefined, imported);
    const oldToken = await (await createTokenSigner([{ secret: TEST_SIGNING_KEY }])).sign({
      campaignId: s.campaignId,
      recipientId: s.recipientId,
    });
    const verifier = await createTokenSigner(ring.map((secret) => ({ secret })));
    expect(await verifier.verify(oldToken)).toMatchObject({
      campaignId: s.campaignId,
      recipientId: s.recipientId,
      retired: true,
    });

    // The pinned suppression key is found among the imported keys.
    const hasher = await createPinnedEmailHasher(env.RESTORE_DB, ring);
    expect(await hasher(normalizeEmail(SUPPRESSED) as string)).toBe(s.suppressionHash);

    // The summary for the first-run screen.
    const status = await readRestoreStatus(target());
    expect(status).toMatchObject({ status: "succeeded", remainingDays: 0, estimatedDays: 1 });
    // Every row is in, or skipped as an orphan. The owner marker goes in last, apart.
    expect((status?.rowsInserted ?? 0) + (status?.rowsSkipped ?? 0)).toBe(manifest.totalRows - 1);
    expect(status?.tables.find((t) => t.table === "contacts")).toMatchObject({
      totalRows: manifest.tables.find((t) => t.name === "contacts")?.rows,
    });
  });

  it("keeps a suppressed address suppressed on import after the restore", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const s = await seedSource();
    const { result } = await restore(manifest, { source: "upload" });
    expect(result).toBe("succeeded");
    const conn = target();
    const cipher = await cipherOfTarget();
    const ring = signingKeyRing(
      TARGET_SIGNING_KEY,
      undefined,
      await readImportedSigningKeys(conn, cipher),
    );
    const services = {
      ...(await testServices()),
      credentials: cipher,
      hashEmail: await createPinnedEmailHasher(env.RESTORE_DB, ring),
    };
    const principal = sessionPrincipal({ workspaceId: s.workspaceId, userId: s.userId });
    const run = <O>(operation: Parameters<typeof runOperation>[1], input: unknown) =>
      runOperation(principal, operation, input, { db: conn, services }) as Promise<O>;
    const upload = await run<{ id: number }>(importsCreate, {
      filename: "again.csv",
      content: `email\n${SUPPRESSED}\nnew.person@example.org\n`,
    });
    await run(importsPreview, {
      id: upload.id,
      mapping: ["email"],
      consentBasis: "existing_customer",
    });
    await runImportJob({ db: conn, services }, services.jobs.at(-1) as ImportJob);
    await run(importsStart, { id: upload.id });
    await runImportJob({ db: conn, services }, services.jobs.at(-1) as ImportJob);
    const done = await run<{ counts: ImportCounts }>(importsGet, { id: upload.id });
    expect(done.counts).toMatchObject({ skippedSuppressed: 1, new: 1 });
  });

  it("refuses a wrong passphrase before any data row, and counts it", async () => {
    await wipeTarget();
    const manifest = await backUp();
    let counted = 0;
    const { result, run } = await restore(manifest, {
      passphrase: "not the passphrase at all",
      onWrongPassphrase: async () => {
        counted += 1;
      },
    });
    expect(result).toBe("wrong passphrase");
    expect(run).toMatchObject({
      status: "failed",
      error_code: "wrong_passphrase",
      position: 0,
      sealed_key: null,
    });
    expect(counted).toBe(1);
    expect(await dataRows(env.RESTORE_DB)).toBe(0);
    expect(await count(env.RESTORE_DB, "system_settings")).toBe(0);
    // The derivation keeps no secret.
    const derivation = await env.RESTORE_DB.prepare(
      "SELECT sealed_secret, sealed_state, sealed_result FROM key_derivations ORDER BY id DESC",
    ).first();
    expect(derivation).toEqual({ sealed_secret: null, sealed_state: null, sealed_result: null });
  });

  it("refuses a changed manifest before any data row", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const key = backupPrefix(manifest.backupId) + MANIFEST_KEY;
    const original = await (await env.BUCKET.get(key))?.text();
    try {
      const changed = { ...manifest, totalRows: manifest.totalRows + 1 };
      await env.BUCKET.put(key, JSON.stringify(changed));
      const { result, run } = await restore(manifest, { manifest: changed });
      expect(result).toBe("invalid backup");
      expect(run).toMatchObject({ status: "failed", error_code: "invalid_backup" });
      expect(run.error).toContain("changed");
      expect(await dataRows(env.RESTORE_DB)).toBe(0);
    } finally {
      if (original) await env.BUCKET.put(key, original);
    }
  });

  it("refuses a newer backup and a deployment that has an owner", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const cipher = await cipherOfTarget();
    const newer = { ...manifest, schemaVersion: BACKUP_SCHEMA_VERSION + 1 };
    const error = await rejection(
      beginRestore(
        target(),
        cipher,
        { source: "r2", sourceKey: manifest.backupId, manifest: newer, passphrase: PASSPHRASE },
        NOW,
      ),
    );
    expect(isOperationError(error) && error.code).toBe("invalid_input");

    await env.RESTORE_DB.prepare(
      "INSERT INTO system_settings (key, value) VALUES ('owner_user_id', 'someone')",
    ).run();
    const owned = await rejection(
      beginRestore(
        target(),
        cipher,
        { source: "r2", sourceKey: manifest.backupId, manifest, passphrase: PASSPHRASE },
        NOW,
      ),
    );
    expect(isOperationError(owned) && owned.code).toBe("conflict");
    expect(await count(env.RESTORE_DB, "restore_runs")).toBe(0);
  });

  it("refuses a second restore while one runs", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const cipher = await cipherOfTarget();
    const input = {
      source: "r2" as const,
      sourceKey: manifest.backupId,
      manifest,
      passphrase: PASSPHRASE,
    };
    await beginRestore(target(), cipher, input, NOW);
    const error = await rejection(beginRestore(target(), cipher, input, NOW + 1000));
    expect(isOperationError(error) && error.code).toBe("conflict");
  });

  it("sleeps at the daily write budget and resumes from the last committed chunk", async () => {
    await wipeTarget();
    const manifest = await backUp();
    // The day fills by 1,000 rows per chunk. After the reset, the count starts again.
    let written = 0;
    let day = 0;
    const h0 = { lastSleeps: 0 };
    const options: RestoreOptions = {
      writeBudget: 2_500,
      usage: () => ({
        day: `2026-10-${21 + day}`,
        rowsWritten: written,
        dailyLimit: 100_000,
        platformLimit: null,
      }),
    };
    const { h, result, run } = await (async () => {
      const h = harness();
      const conn = target();
      const started = await beginRestore(
        conn,
        await cipherOfTarget(),
        { source: "r2", sourceKey: manifest.backupId, manifest, passphrase: PASSPHRASE },
        NOW,
      );
      const base = depsFactory(h, options);
      const deps = async <T>(work: (deps: RestoreDeps) => Promise<T>) =>
        base(async (d) => {
          const out = await work(d);
          if ((out as { kind?: string }).kind === "done") written += 1_000;
          return out;
        });
      h.runner.sleepUntil = async (_name, until) => {
        h.sleeps.push(until);
        h.clock.now = until;
        written = 0;
        day += 1;
        h0.lastSleeps += 1;
      };
      const result = await driveRestore(
        h.runner,
        restoreSteps(deps, started.job, async () => {}),
      );
      const run = await conn.db
        .selectFrom("restore_runs")
        .selectAll()
        .where("id", "=", started.runId)
        .executeTakeFirstOrThrow();
      return { h, result, run };
    })();
    expect(result).toBe("succeeded");
    expect(h.sleeps.length).toBeGreaterThan(0);
    // Each wait ends after the next 00:00 UTC, and the same chunk runs again.
    expect(h.sleeps[0]).toBeGreaterThan(NOW);
    const resumed = h.steps.find((name) => name.endsWith("(after pause 1)"));
    expect(resumed).toBeDefined();
    expect(h.steps).toContain(resumed?.replace(" (after pause 1)", ""));
    expect(run.position).toBe(manifest.chunks.length);
    for (const table of ["contacts", "list_members", "campaign_recipients"]) {
      const mark = manifest.tables.find((t) => t.name === table)?.highWaterMark ?? 0;
      expect(await count(env.RESTORE_DB, table)).toBe(
        await count(env.DB, table, `WHERE rowid <= ${mark}`),
      );
    }
  });

  it("goes on in a new Workflow instance when one instance runs out of steps", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const { h, result, run } = await restore(manifest, { maxSteps: 8 });
    expect(result).toBe("succeeded");
    expect(h.next.length).toBeGreaterThan(0);
    expect(run.generation).toBe(h.next.length);
    // A later instance needs no passphrase: the sealed key is in the run.
    expect(h.steps.filter((name) => name === "check the passphrase")).toHaveLength(1);
  });

  it("skips orphan rows and reports them", async () => {
    await wipeTarget();
    const s = await seedSource();
    // After the marks, a tag moves to a contact that is not in the backup.
    const manifest = await backUp(async (name) => {
      if (name !== "begin") return;
      const conn = source();
      const late = await conn.db
        .insertInto("contacts")
        .values({
          workspace_id: s.workspaceId,
          email: `late-${crypto.randomUUID()}@example.org`,
          first_name: null,
          last_name: null,
          consent_basis: "explicit_opt_in",
          consent_source: "test",
          consent_at: NOW,
          source: "test",
          email_hash: null,
          unsubscribed_at: null,
          unsubscribe_source: null,
          unsubscribe_campaign_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const tagged = await env.DB.prepare(
        "SELECT rowid AS id FROM contact_tags WHERE workspace_id = ? ORDER BY rowid LIMIT 1",
      )
        .bind(s.workspaceId)
        .first<{ id: number }>();
      if (!tagged) throw new Error("No tagged contact.");
      await sql`UPDATE contact_tags SET contact_id = ${late.id} WHERE rowid = ${tagged.id}`.execute(
        conn.db,
      );
    });
    const { result, run } = await restore(manifest);
    expect(result).toBe("succeeded");
    expect(run.rows_skipped).toBeGreaterThanOrEqual(1);
    const status = await readRestoreStatus(target());
    expect(
      status?.tables.find((t) => t.table === "contact_tags")?.rowsSkipped,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("after a restore", () => {
  it("holds campaign sends until the owner confirms the backup age", async () => {
    await wipeTarget();
    const manifest = await backUp();
    const s = await seedSource();
    await restore(manifest);
    const conn = target();
    expect(await readRestoreAck(conn)).toMatchObject({
      backupId: manifest.backupId,
      backupCreatedAt: manifest.createdAt,
    });
    const services = { ...(await testServices()), credentials: await cipherOfTarget() };
    const principal = sessionPrincipal({
      workspaceId: s.workspaceId,
      userId: s.userId,
      signedInAt: NOW,
    });
    const blocked = await rejection(
      runOperation(
        principal,
        campaignsConfirm,
        { id: s.campaignId, token: "x" },
        { db: conn, services, now: () => NOW },
      ),
    );
    expect(isOperationError(blocked) && blocked.code).toBe("conflict");
    expect((blocked as { details: unknown }).details).toEqual({ code: "RESTORE_ACK_REQUIRED" });

    // The dispatch puts no batch on the queue while the flag is set.
    await env.RESTORE_DB.prepare("UPDATE campaigns SET status = 'sending' WHERE id = ?")
      .bind(s.campaignId)
      .run();
    await env.RESTORE_DB.prepare(
      "INSERT INTO campaign_batches (workspace_id, campaign_id, seq, status) VALUES (?, ?, 999, 'pending')",
    )
      .bind(s.workspaceId, s.campaignId)
      .run();
    const queue = {
      sent: 0,
      send: async (pointers: readonly unknown[]) => {
        queue.sent += pointers.length;
      },
    };
    expect(await dispatchBatches(conn, queue, s.workspaceId, s.campaignId, NOW)).toEqual([]);

    const before = await runOperation(
      principal,
      backupsGet,
      {},
      { db: conn, services, now: () => NOW },
    );
    expect(before.restore).toMatchObject({ backupId: manifest.backupId });
    const after = await runOperation(
      principal,
      backupsAcknowledgeRestore,
      {},
      { db: conn, services, now: () => NOW },
    );
    expect(after.restore).toBeNull();
    expect(await dispatchBatches(conn, queue, s.workspaceId, s.campaignId, NOW)).toHaveLength(1);
    expect(
      await env.RESTORE_DB.prepare("SELECT 1 FROM system_settings WHERE key = ?")
        .bind(RESTORE_ACK_SETTING)
        .first(),
    ).toBeNull();
    const audit = await env.RESTORE_DB.prepare(
      "SELECT action FROM audit_log WHERE action IN ('setup.restored', 'backups.acknowledge_restore') ORDER BY id",
    ).all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual([
      "setup.restored",
      "backups.acknowledge_restore",
    ]);
  });
});

describe("backup download", () => {
  async function ownerOf(signedInAt: number | null) {
    const s = await seedSource();
    return sessionPrincipal({ workspaceId: s.workspaceId, userId: s.userId, signedInAt });
  }

  it("gives a short-lived link to the archive after a recent sign-in, and audits it", async () => {
    await backUp();
    const conn = testDb();
    const services = await testServices();
    const run = await conn.db
      .selectFrom("backup_runs")
      .select(["id", "backup_id"])
      .where("status", "=", "succeeded")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    const principal = await ownerOf(NOW - 60_000);
    const link = await runOperation(
      principal,
      backupsDownload,
      { id: run.id },
      { db: conn, services, now: () => NOW },
    );
    expect(link.url.startsWith("/api/files/")).toBe(true);
    expect(link.expiresAt).toBe(NOW + 15 * 60 * 1000);
    expect(link.filename).toMatch(/^envelopen-backup-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.envbak$/);
    const audit = await conn.db
      .selectFrom("audit_log")
      .select(["action", "target_id"])
      .where("workspace_id", "=", (await seedSource()).workspaceId)
      .where("action", "=", "backups.download")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.target_id).toBe(String(run.id));
  });

  it("refuses a stale session and every API key", async () => {
    const conn = testDb();
    for (const signedInAt of [NOW - RECENT_SIGN_IN_MS - 1, null]) {
      const principal = await ownerOf(signedInAt);
      const error = await rejection(
        runOperation(principal, backupsDownload, { id: 1 }, { db: conn, now: () => NOW }),
      );
      expect(isOperationError(error) && error.code).toBe("forbidden");
      expect((error as { details: unknown }).details).toEqual({ code: "SESSION_NOT_FRESH" });
    }
    const s = await seedSource();
    const created = await createApiKey(conn, s.workspaceId, API_KEY_SCOPES);
    const principal = await resolveApiKey(conn, created.key, { surface: "rest" });
    if (!principal) throw new Error("The key did not resolve.");
    const cases: [Operation, unknown][] = [
      [backupsDownload, { id: 1 }],
      [backupsAcknowledgeRestore, {}],
    ];
    for (const [operation, input] of cases) {
      const error = await rejection(runOperation(principal, operation, input, { db: conn }));
      expect(isOperationError(error) && error.code).toBe("forbidden");
    }
    for (const id of ["backups.download", "backups.acknowledge_restore"]) {
      expect(registry.get(id)?.scope).toBe("workspace:admin");
      expect(registry.get(id)?.mcp.class).toBe("never");
    }
  });
});
