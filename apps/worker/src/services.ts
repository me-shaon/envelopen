import {
  type BatchPointer,
  type CampaignJob,
  type CredentialCipher,
  createCredentialCipher,
  createFileLinkSigner,
  createPinnedEmailHasher,
  type EmailHasher,
  type FileLinkSigner,
  type ImportJob,
  type SendQueue,
  type Services,
} from "@envelopen/core";
import { createTokenSigner, type TokenSigner, tokenKeysFromEnv } from "@envelopen/email-render";
import { isUsableKey } from "./auth/better-auth";
import { usageReader } from "./do/usage";

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

/**
 * The suppression hasher with the pinned key (see packages/core/src/suppression/hash.ts).
 * It looks for the pinned key in SIGNING_KEY and SIGNING_KEYS_RETIRED, so a rotation
 * keeps every suppression. A failed setup is not cached, so the next call tries again.
 */
function emailHasher(
  env: Pick<Env, "DB" | "SIGNING_KEYS_RETIRED">,
  signingKey: string,
): Promise<EmailHasher> {
  const keys = `${signingKey}|${env.SIGNING_KEYS_RETIRED ?? ""}`;
  if (hasher?.keys !== keys) {
    const secrets = tokenKeysFromEnv(signingKey, env.SIGNING_KEYS_RETIRED).map(
      (entry) => entry.secret,
    );
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
 * retired keys still verify. The key derivation runs once per isolate.
 */
export function tokenSigner(
  env: Pick<Env, "SIGNING_KEY" | "SIGNING_KEYS_RETIRED">,
): Promise<TokenSigner> {
  const current = env.SIGNING_KEY;
  if (!isUsableKey(current)) return Promise.reject(new Error("SIGNING_KEY is missing."));
  const keys = `${current}|${env.SIGNING_KEYS_RETIRED ?? ""}`;
  if (tokens?.keys !== keys) {
    tokens = {
      keys,
      value: createTokenSigner(tokenKeysFromEnv(current, env.SIGNING_KEYS_RETIRED)),
    };
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

export function createServices(
  env: Pick<
    Env,
    | "BUCKET"
    | "IMPORT_WORKFLOW"
    | "CAMPAIGN_WORKFLOW"
    | "SEND_QUEUE"
    | "USAGE_METER"
    | "DB"
    | "SIGNING_KEY"
    | "SIGNING_KEYS_RETIRED"
    | "ENCRYPTION_KEY"
    | "OUTBOUND_MOCK_ORIGIN"
  >,
  request?: Request,
): Partial<Services> {
  const services: Partial<Services> = {
    bucket: env.BUCKET,
    async startImportJob(job) {
      await env.IMPORT_WORKFLOW.create({ id: importInstanceId(job), params: job });
    },
    outboundFetch: outboundFetch(env),
    startCampaignJob: campaignStarter(env),
    sendQueue: sendQueue(env),
    usage: usageReader(env),
  };
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
