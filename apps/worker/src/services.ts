import {
  type CredentialCipher,
  createCredentialCipher,
  createEmailHasher,
  createFileLinkSigner,
  type EmailHasher,
  type FileLinkSigner,
  type ImportJob,
  type Services,
} from "@envelopen/core";
import { isUsableKey } from "./auth/better-auth";

// Builds the platform services that operations need from the Worker's bindings (see
// packages/core/src/services.ts). The keyed hasher, the link signer, and the
// credential cipher derive their keys once per isolate.

interface KeyedServices {
  signingKey: string;
  hasher: Promise<EmailHasher>;
  signer: Promise<FileLinkSigner>;
}

let keyed: KeyedServices | undefined;
let cipher: { key: string; value: Promise<CredentialCipher> } | undefined;

/** ENCRYPTION_KEY is key version 1. A rotation adds version 2 next to it. */
const ENCRYPTION_KEY_VERSION = 1;

function keyedServices(signingKey: string): KeyedServices {
  if (keyed?.signingKey !== signingKey) {
    keyed = {
      signingKey,
      hasher: createEmailHasher(signingKey),
      signer: createFileLinkSigner(signingKey),
    };
  }
  return keyed;
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

/** The Workflow instance id of an import run. Each run has its own. */
export function importInstanceId(job: ImportJob): string {
  return `import-${job.workspaceId}-${job.importId}-${job.mode}-${job.generation}`;
}

export function createServices(
  env: Pick<
    Env,
    "BUCKET" | "IMPORT_WORKFLOW" | "SIGNING_KEY" | "ENCRYPTION_KEY" | "OUTBOUND_MOCK_ORIGIN"
  >,
  request?: Request,
): Partial<Services> {
  const services: Partial<Services> = {
    bucket: env.BUCKET,
    async startImportJob(job) {
      await env.IMPORT_WORKFLOW.create({ id: importInstanceId(job), params: job });
    },
    outboundFetch: outboundFetch(env),
  };
  // Webhook URLs point at the origin that the owner uses for the admin app.
  if (request) services.appOrigin = new URL(request.url).origin;
  // Without SIGNING_KEY, the operations that need a hash or a link fail. The first-run
  // screen reports the missing secret. The same goes for ENCRYPTION_KEY and connections.
  if (isUsableKey(env.SIGNING_KEY)) {
    const { hasher, signer } = keyedServices(env.SIGNING_KEY);
    services.hashEmail = async (email) => (await hasher)(email);
    services.signFileLink = async (file) => (await signer).sign(file);
  }
  if (isUsableKey(env.ENCRYPTION_KEY)) services.credentials = credentialCipher(env.ENCRYPTION_KEY);
  return services;
}
