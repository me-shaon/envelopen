import {
  type BackupJob,
  type BatchPointer,
  type CampaignJob,
  type CredentialCipher,
  createCredentialCipher,
  createFileLinkSigner,
  createPinnedEmailHasher,
  type EmailHasher,
  type FileLinkSigner,
  type ImportJob,
  type KeyDerivationJob,
  type RestoreJob,
  readImportedSigningKeys,
  type SendQueue,
  type Services,
  type SettingsCache,
  signingKeyRing,
  type WelcomeJob,
  type WelcomeRunner,
  welcomeInstanceId,
} from "@envelopen/core";
import { createDb } from "@envelopen/db";
import { createTokenSigner, type TokenSigner } from "@envelopen/email-render";
import { isUsableKey } from "./auth/better-auth";
import { dailyCounter } from "./do/daily-counter";
import { usageReader } from "./do/usage";
import { turnstileKeys } from "./forms/turnstile";
import { socketConnect } from "./sockets";

// Builds the platform services that operations need from the Worker's bindings (see
// packages/core/src/services.ts). The keyed hasher, the link signer, and the
// credential cipher derive their keys once per isolate.

interface KeyedServices {
  signingKey: string;
  signer: Promise<FileLinkSigner>;
}

let keyed: KeyedServices | undefined;
let hasher: { keys: string; value: Promise<EmailHasher> } | undefined;
let cipher: { key: string; value: Promise<CredentialCipher> } | undefined;
let tokens: { keys: string; value: Promise<TokenSigner> } | undefined;

/** ENCRYPTION_KEY is key version 1. A rotation adds version 2 next to it. */
const ENCRYPTION_KEY_VERSION = 1;

function keyedServices(signingKey: string): KeyedServices {
  if (keyed?.signingKey !== signingKey) {
    keyed = {
      signingKey,
      signer: createFileLinkSigner(signingKey),
    };
  }
  return keyed;
}

type KeyRingEnv = Pick<
  Env,
  "DB" | "KV" | "SIGNING_KEY" | "SIGNING_KEYS_RETIRED" | "ENCRYPTION_KEY"
>;

/** How long an isolate keeps the imported signing keys before it reads them again. */
const IMPORTED_KEYS_TTL_MS = 5 * 60 * 1000;
let imported: { at: number; value: Promise<string[]> } | undefined;

/**
 * The signing keys that a restore imported (U5, KTD3), from the settings cache in KV,
 * then D1. An isolate keeps them for 5 minutes. A failed read gives no imported keys
 * and is not kept, so the next call tries again.
 */
export function importedSigningKeys(env: KeyRingEnv): Promise<string[]> {
  if (!isUsableKey(env.ENCRYPTION_KEY)) return Promise.resolve([]);
  const now = Date.now();
  if (!imported || now - imported.at > IMPORTED_KEYS_TTL_MS) {
    const cipher = credentialCipher(env.ENCRYPTION_KEY);
    const entry = {
      at: now,
      value: readImportedSigningKeys(createDb(env), cipher, settingsCache(env)).catch(
        (error: unknown) => {
          console.error("The imported signing keys did not load", error);
          if (imported === entry) imported = undefined;
          return [] as string[];
        },
      ),
    };
    imported = entry;
  }
  return imported.value;
}

/** Forgets the imported keys of this isolate. The restore and the tests call it. */
export function forgetImportedSigningKeys(): void {
  imported = undefined;
}

/**
 * The key ring of the token signer and the suppression hasher: SIGNING_KEY, then
 * SIGNING_KEYS_RETIRED, then the imported keys.
 */
async function keyRing(env: KeyRingEnv, signingKey: string): Promise<string[]> {
  return signingKeyRing(signingKey, env.SIGNING_KEYS_RETIRED, await importedSigningKeys(env));
}

/**
 * The suppression hasher with the pinned key (see packages/core/src/suppression/hash.ts).
 * It looks for the pinned key in the key ring, so a rotation and a restore keep every
 * suppression. A failed setup is not cached, so the next call tries again.
 */
async function emailHasher(env: KeyRingEnv, signingKey: string): Promise<EmailHasher> {
  const secrets = await keyRing(env, signingKey);
  const keys = secrets.join("|");
  if (hasher?.keys !== keys) {
    const value = createPinnedEmailHasher(env.DB, secrets);
    const entry = { keys, value };
    hasher = entry;
    value.catch(() => {
      if (hasher === entry) hasher = undefined;
    });
  }
  return hasher.value;
}

/** The cipher's key derivation is async, so the service awaits it on first use. */
function credentialCipher(encryptionKey: string): CredentialCipher {
  if (cipher?.key !== encryptionKey) {
    cipher = {
      key: encryptionKey,
      value: createCredentialCipher([{ version: ENCRYPTION_KEY_VERSION, secret: encryptionKey }]),
    };
  }
  const ready = cipher.value;
  return {
    version: ENCRYPTION_KEY_VERSION,
    encrypt: async (plaintext, owner) => (await ready).encrypt(plaintext, owner),
    decrypt: async (ciphertext, version, owner) =>
      (await ready).decrypt(ciphertext, version, owner),
  };
}

/**
 * Outbound HTTP to providers and to DNS over HTTPS. For the end-to-end tests only,
 * OUTBOUND_MOCK_ORIGIN sends every outbound request to a local mock server instead,
 * as `<mock>/<original host><path>`. It works only with a localhost origin, so a
 * deployed Worker cannot be pointed at another server by mistake.
 */
export function outboundFetch(env: Pick<Env, "OUTBOUND_MOCK_ORIGIN">): typeof fetch {
  const mock = env.OUTBOUND_MOCK_ORIGIN;
  if (!mock) return (input, init) => fetch(input, init);
  const origin = new URL(mock);
  if (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new Error("OUTBOUND_MOCK_ORIGIN must be a localhost address.");
  }
  return (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const url = `${origin.origin}/${target.host}${target.pathname}${target.search}`;
    return fetch(new Request(url, request));
  };
}

/** The link signer, or null when SIGNING_KEY is missing. */
export function fileLinkSigner(env: Pick<Env, "SIGNING_KEY">): Promise<FileLinkSigner> | null {
  return isUsableKey(env.SIGNING_KEY) ? keyedServices(env.SIGNING_KEY).signer : null;
}

/**
 * The signer of unsubscribe and tracking tokens (KTD28): SIGNING_KEY signs, and the
 * retired keys and the keys that a restore imported still verify. The key derivation
 * runs once per isolate and key ring.
 */
export async function tokenSigner(env: KeyRingEnv): Promise<TokenSigner> {
  const current = env.SIGNING_KEY;
  if (!isUsableKey(current)) throw new Error("SIGNING_KEY is missing.");
  const ring = await keyRing(env, current);
  const keys = ring.join("|");
  if (tokens?.keys !== keys) {
    tokens = { keys, value: createTokenSigner(ring.map((secret) => ({ secret }))) };
  }
  return tokens.value;
}

/** The send queue as the engine uses it: pointers in calls of at most 100 messages. */
export function sendQueue(env: Pick<Env, "SEND_QUEUE">): SendQueue {
  return {
    async send(pointers: readonly BatchPointer[]) {
      for (let start = 0; start < pointers.length; start += 100) {
        await env.SEND_QUEUE.sendBatch(
          pointers
            .slice(start, start + 100)
            .map((body) => ({ body, contentType: "json" as const })),
        );
      }
    },
  };
}

/** The Workflow instance id of a campaign start. */
export function campaignInstanceId(job: CampaignJob): string {
  return `campaign-${job.workspaceId}-${job.campaignId}-${job.startedAt}`;
}

/**
 * Starts the snapshot Workflow of a campaign. The sweep calls it again for a snapshot
 * that did not finish: a running instance keeps running, and an instance that failed
 * gets a successor, because the snapshot is safe to repeat.
 */
export function campaignStarter(env: Pick<Env, "CAMPAIGN_WORKFLOW">) {
  return async (job: CampaignJob): Promise<void> => {
    const id = campaignInstanceId(job);
    try {
      await env.CAMPAIGN_WORKFLOW.create({ id, params: job });
      return;
    } catch (error) {
      let status: string;
      try {
        status = (await (await env.CAMPAIGN_WORKFLOW.get(id)).status()).status;
      } catch {
        throw error;
      }
      if (status !== "errored" && status !== "terminated") return;
      await env.CAMPAIGN_WORKFLOW.create({ id: `${id}-r${Date.now()}`, params: job });
    }
  };
}

/** The Workflow instance id of an import run. Each run has its own. */
export function importInstanceId(job: ImportJob): string {
  return `import-${job.workspaceId}-${job.importId}-${job.mode}-${job.generation}`;
}

/** The Workflow instance id of a backup run. */
export function backupInstanceId(job: BackupJob): string {
  return `backup-${job.backupId}`;
}

/** Starts the backup Workflow of one run (U4). */
export function backupStarter(env: Pick<Env, "BACKUP_WORKFLOW">) {
  return async (job: BackupJob): Promise<void> => {
    await env.BACKUP_WORKFLOW.create({ id: backupInstanceId(job), params: job });
  };
}

/** The Workflow instance id of one restore instance (U5). */
export function restoreInstanceId(job: RestoreJob): string {
  return `restore-${job.runId}-${job.generation}`;
}

/** Starts the restore Workflow (U5). */
export function restoreStarter(env: Pick<Env, "RESTORE_WORKFLOW">) {
  return async (job: RestoreJob): Promise<void> => {
    await env.RESTORE_WORKFLOW.create({ id: restoreInstanceId(job), params: job });
  };
}

/** Starts the key derivation Workflow of one passphrase (U4). */
export function keyDerivationStarter(env: Pick<Env, "KEY_DERIVATION_WORKFLOW">) {
  return async (job: KeyDerivationJob): Promise<void> => {
    await env.KEY_DERIVATION_WORKFLOW.create({ id: `key-${job.derivationId}`, params: job });
  };
}

/**
 * Starts and stops welcome series instances (U10, KTD8). The instance id
 * `welcome-<contactId>-<seriesId>` makes a second start of the same contact and series
 * a no-op: Workflows refuse an id that exists. Workflows allow only letters, digits, `-`,
 * and `_` in an id, so the parts are joined with `-`.
 */
export function welcomeRunner(env: Pick<Env, "WELCOME_WORKFLOW">): WelcomeRunner {
  return {
    async start(jobs) {
      const started: WelcomeJob[] = [];
      for (const job of jobs) {
        const id = welcomeInstanceId(job);
        const params: WelcomeJob = {
          workspaceId: job.workspaceId,
          seriesId: job.seriesId,
          contactId: job.contactId,
        };
        try {
          await env.WELCOME_WORKFLOW.create({ id, params });
          started.push(job);
        } catch (error) {
          // The instance exists: the contact got this series already.
          const exists = await env.WELCOME_WORKFLOW.get(id).then(
            () => true,
            () => false,
          );
          if (!exists) console.error(`Welcome instance ${id} did not start`, error);
        }
      }
      return started;
    },
    async stop(jobs) {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            const instance = await env.WELCOME_WORKFLOW.get(welcomeInstanceId(job));
            await instance.terminate();
          } catch {
            // No instance, or it is finished already. The per-step check covers the rest.
          }
        }),
      );
    },
  };
}

export { dailyCounter };

/** KV keys of the settings cache start with this prefix. */
const SETTINGS_PREFIX = "settings:";
/** How long an edge location keeps a read in its local cache. */
const SETTINGS_EDGE_TTL_SECONDS = 300;
/** How long KV keeps a cached value. A missed write-through heals after this time. */
const SETTINGS_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * The cache of deployment settings in KV (KTD16). The public pages read the source link
 * from it, so a page view needs no D1 read in the common case.
 */
export function settingsCache(env: Pick<Env, "KV">): SettingsCache | undefined {
  const kv = env.KV;
  if (!kv) return undefined;
  return {
    get: (key) => kv.get(SETTINGS_PREFIX + key, { cacheTtl: SETTINGS_EDGE_TTL_SECONDS }),
    put: (key, value) =>
      kv.put(SETTINGS_PREFIX + key, value, { expirationTtl: SETTINGS_EXPIRY_SECONDS }),
  };
}

export function createServices(
  env: Pick<
    Env,
    | "BUCKET"
    | "IMPORT_WORKFLOW"
    | "CAMPAIGN_WORKFLOW"
    | "BACKUP_WORKFLOW"
    | "KEY_DERIVATION_WORKFLOW"
    | "SEND_QUEUE"
    | "USAGE_METER"
    | "DB"
    | "SIGNING_KEY"
    | "SIGNING_KEYS_RETIRED"
    | "ENCRYPTION_KEY"
    | "OUTBOUND_MOCK_ORIGIN"
    | "OUTBOUND_MOCK_SMTP"
    | "KV"
    | "TURNSTILE_SITE_KEY"
    | "TURNSTILE_SECRET"
    | "WELCOME_WORKFLOW"
    | "RATE_LIMITER"
  >,
  request?: Request,
): Partial<Services> {
  const services: Partial<Services> = {
    bucket: env.BUCKET,
    async startImportJob(job) {
      await env.IMPORT_WORKFLOW.create({ id: importInstanceId(job), params: job });
    },
    outboundFetch: outboundFetch(env),
    connectSocket: socketConnect(env),
    startCampaignJob: campaignStarter(env),
    startBackupJob: backupStarter(env),
    startKeyDerivation: keyDerivationStarter(env),
    sendQueue: sendQueue(env),
    usage: usageReader(env),
    turnstileConfigured: turnstileKeys(env) !== null,
    welcome: welcomeRunner(env),
    dailyCounter: dailyCounter(env),
  };
  const cache = settingsCache(env);
  if (cache) services.settingsCache = cache;
  // Webhook URLs point at the origin that the owner uses for the admin app.
  if (request) services.appOrigin = new URL(request.url).origin;
  // Without SIGNING_KEY, the operations that need a hash or a link fail. The first-run
  // screen reports the missing secret. The same goes for ENCRYPTION_KEY and connections.
  if (isUsableKey(env.SIGNING_KEY)) {
    const signingKey = env.SIGNING_KEY;
    const { signer } = keyedServices(signingKey);
    services.hashEmail = async (email) => (await emailHasher(env, signingKey))(email);
    services.signFileLink = async (file) => (await signer).sign(file);
  }
  if (isUsableKey(env.ENCRYPTION_KEY)) services.credentials = credentialCipher(env.ENCRYPTION_KEY);
  return services;
}
