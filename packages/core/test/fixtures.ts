import { env } from "cloudflare:workers";
import { createDb, type DbConnection } from "@envelopen/db";
import type { SocketConnect } from "@envelopen/providers";
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
import { type WelcomeJob, welcomeInstanceId } from "../src/welcome/model";

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

/** Outbound TCP for tests that do not expect any. A call fails the test. */
const noSockets: SocketConnect = (target) => {
  throw new Error(`Unexpected outbound socket in a test: ${target.hostname}:${target.port}`);
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
  /** Welcome instances that started, in order. An instance id starts once, as in Workflows. */
  welcomeStarts: WelcomeJob[];
  /** Welcome instances that a stop asked to terminate, in order. */
  welcomeStops: WelcomeJob[];
}

/** Services as the Worker builds them, with a job recorder in place of the Workflow. */
export async function testServices(
  options: { fetch?: typeof fetch; connect?: SocketConnect } = {},
): Promise<TestServices> {
  const signer = await createFileLinkSigner(TEST_SIGNING_KEY);
  const jobs: ImportJob[] = [];
  const campaignJobs: CampaignJob[] = [];
  const backupJobs: BackupJob[] = [];
  const derivationJobs: KeyDerivationJob[] = [];
  const queued: BatchPointer[] = [];
  const welcomeStarts: WelcomeJob[] = [];
  const welcomeStops: WelcomeJob[] = [];
  const welcomeIds = new Set<string>();
  const services: TestServices = {
    bucket: env.BUCKET,
    hashEmail: await createEmailHasher(TEST_SIGNING_KEY),
    signFileLink: (file) => signer.sign(file),
    async startImportJob(job) {
      jobs.push(job);
    },
    credentials: await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]),
    outboundFetch: options.fetch ?? noNetwork,
    connectSocket: options.connect ?? noSockets,
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
    welcomeStarts,
    welcomeStops,
    welcome: {
      async start(jobs) {
        const fresh = jobs.filter((job) => !welcomeIds.has(welcomeInstanceId(job)));
        for (const job of fresh) welcomeIds.add(welcomeInstanceId(job));
        welcomeStarts.push(...fresh);
        return fresh;
      },
      async stop(jobs) {
        welcomeStops.push(...jobs);
      },
    },
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
