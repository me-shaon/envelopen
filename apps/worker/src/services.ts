import {
  createEmailHasher,
  createFileLinkSigner,
  type EmailHasher,
  type FileLinkSigner,
  type ImportJob,
  type Services,
} from "@envelopen/core";
import { isUsableKey } from "./auth/better-auth";

// Builds the platform services that operations need from the Worker's bindings (see
// packages/core/src/services.ts). The keyed hasher and the link signer derive their keys
// from SIGNING_KEY once per isolate.

interface KeyedServices {
  signingKey: string;
  hasher: Promise<EmailHasher>;
  signer: Promise<FileLinkSigner>;
}

let keyed: KeyedServices | undefined;

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

/** The link signer, or null when SIGNING_KEY is missing. */
export function fileLinkSigner(env: Pick<Env, "SIGNING_KEY">): Promise<FileLinkSigner> | null {
  return isUsableKey(env.SIGNING_KEY) ? keyedServices(env.SIGNING_KEY).signer : null;
}

/** The Workflow instance id of an import run. Each run has its own. */
export function importInstanceId(job: ImportJob): string {
  return `import-${job.workspaceId}-${job.importId}-${job.mode}-${job.generation}`;
}

export function createServices(
  env: Pick<Env, "BUCKET" | "IMPORT_WORKFLOW" | "SIGNING_KEY">,
): Partial<Services> {
  const services: Partial<Services> = {
    bucket: env.BUCKET,
    async startImportJob(job) {
      await env.IMPORT_WORKFLOW.create({ id: importInstanceId(job), params: job });
    },
  };
  // Without SIGNING_KEY, the operations that need a hash or a link fail. The first-run
  // screen reports the missing secret.
  if (isUsableKey(env.SIGNING_KEY)) {
    const { hasher, signer } = keyedServices(env.SIGNING_KEY);
    services.hashEmail = async (email) => (await hasher)(email);
    services.signFileLink = async (file) => (await signer).sign(file);
  }
  return services;
}
