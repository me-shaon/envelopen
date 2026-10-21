import { env } from "cloudflare:workers";
import { createDb, type DbConnection } from "@envelopen/db";
import { generateApiKey } from "../src/api-keys";
import { createCredentialCipher } from "../src/crypto/credentials";
import { createFileLinkSigner } from "../src/import/file-links";
import type { ApiKeyScope } from "../src/scopes";
import type {
  BackupJob,
  BatchPointer,
  CampaignJob,
  ImportJob,
  KeyDerivationJob,
  Services,
  SettingsCache,
  UsageStatus,
} from "../src/services";
import { createEmailHasher } from "../src/suppression/hash";

/** A connection that fails any tenant query without a workspace_id condition. */
export function testDb(): DbConnection {
  return createDb(env, { enforceWorkspaceScope: true });
}

export async function createWorkspace(conn: DbConnection, name = "Test"): Promise<number> {
  const row = await conn.db
    .insertInto("workspaces")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function createApiKey(
  conn: DbConnection,
  workspaceId: number,
  scopes: readonly string[] | ApiKeyScope[],
  extra: { expires_at?: number | null; revoked_at?: number | null } = {},
): Promise<{ key: string; id: number }> {
  const generated = await generateApiKey();
  const row = await conn.db
    .insertInto("api_keys")
    .values({
      workspace_id: workspaceId,
      name: "Test key",
      prefix: generated.prefix,
      key_hash: generated.keyHash,
      scopes: JSON.stringify(scopes),
      created_by_user_id: null,
      last_used_at: null,
      expires_at: extra.expires_at ?? null,
      revoked_at: extra.revoked_at ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { key: generated.key, id: row.id };
}

/** An app user, as first-run setup creates it. Returns the id. */
export async function createUser(conn: DbConnection, id = crypto.randomUUID()): Promise<string> {
  await conn.db
    .insertInto("users")
    .values({ id, email: `${id}@example.com`, name: null })
    .execute();
  return id;
}

/** A workspace with the user as its owner member. */
export async function createOwnedWorkspace(
  conn: DbConnection,
  userId: string,
  name = "Test",
): Promise<number> {
  const workspaceId = await createWorkspace(conn, name);
  await conn.db
    .insertInto("workspace_members")
    .values({ workspace_id: workspaceId, user_id: userId, role: "owner" })
    .execute();
  return workspaceId;
}

/** A fixed test key, so hashes match across the tests of one run. */
export const TEST_SIGNING_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const TEST_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
export const TEST_ORIGIN = "https://envelopen.test";

/** Outbound HTTP for tests that do not expect any. A call fails the test. */
const noNetwork: typeof fetch = async (input) => {
  throw new Error(
    `Unexpected outbound request in a test: ${String(input instanceof Request ? input.url : input)}`,
  );
};

/** A settings cache in memory, in place of KV. `entries` shows what it holds. */
export function memorySettingsCache(): SettingsCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    put: async (key, value) => {
      entries.set(key, value);
    },
  };
}

export interface TestServices extends Services {
  /** Import runs that operations started, in order. */
  jobs: ImportJob[];
  /** Campaign snapshot runs that operations started, in order. */
  campaignJobs: CampaignJob[];
  /** Backup runs that operations started, in order. */
  backupJobs: BackupJob[];
  /** Key derivations that operations started, in order. */
  derivationJobs: KeyDerivationJob[];
  /** Batch pointers that operations put on the send queue, in order. */
  queued: BatchPointer[];
  /** What `usage.status()` returns. Tests change it. */
  usageStatus: UsageStatus;
}

/** Services as the Worker builds them, with a job recorder in place of the Workflow. */
export async function testServices(options: { fetch?: typeof fetch } = {}): Promise<TestServices> {
  const signer = await createFileLinkSigner(TEST_SIGNING_KEY);
  const jobs: ImportJob[] = [];
  const campaignJobs: CampaignJob[] = [];
  const backupJobs: BackupJob[] = [];
  const derivationJobs: KeyDerivationJob[] = [];
  const queued: BatchPointer[] = [];
  const services: TestServices = {
    bucket: env.BUCKET,
    hashEmail: await createEmailHasher(TEST_SIGNING_KEY),
    signFileLink: (file) => signer.sign(file),
    async startImportJob(job) {
      jobs.push(job);
    },
    credentials: await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]),
    outboundFetch: options.fetch ?? noNetwork,
    appOrigin: TEST_ORIGIN,
    jobs,
    campaignJobs,
    queued,
    async startCampaignJob(job) {
      campaignJobs.push(job);
    },
    backupJobs,
    async startBackupJob(job) {
      backupJobs.push(job);
    },
    derivationJobs,
    async startKeyDerivation(job) {
      derivationJobs.push(job);
    },
    sendQueue: {
      async send(pointers) {
        queued.push(...pointers);
      },
    },
    usageStatus: { day: "2026-10-19", rowsWritten: 0, dailyLimit: 100_000, platformLimit: null },
    usage: {
      status: async () => services.usageStatus,
    },
    settingsCache: memorySettingsCache(),
    turnstileConfigured: true,
  };
  return services;
}

export function insertContact(
  conn: DbConnection,
  workspaceId: number,
  values: { email: string; consent_basis?: "existing_customer" | "explicit_opt_in" | "unknown" },
) {
  return conn.db
    .insertInto("contacts")
    .values({
      workspace_id: workspaceId,
      email: values.email,
      first_name: null,
      last_name: null,
      consent_basis: values.consent_basis ?? "explicit_opt_in",
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
}
