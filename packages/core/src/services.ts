import type { CredentialCipher } from "./crypto/credentials";

// Platform services that some operations need besides the database. The Worker builds
// them from its bindings and secrets. Tests pass their own. An operation asks for a
// service with `requireService`, so a surface that lacks it fails clearly.

/** Keyed hash (HMAC) of a normalized email address, as lowercase hex. */
export type EmailHasher = (normalizedEmail: string) => Promise<string>;

/** Which run of an import a Workflow instance does. */
export type ImportJobMode = "preview" | "import";

export interface ImportJob {
  workspaceId: number;
  importId: number;
  mode: ImportJobMode;
  /** The preview generation that the run belongs to. Stale runs write nothing. */
  generation: number;
}

/** A link to a file in R2 that works without a session until it expires. */
export interface FileLinkRequest {
  key: string;
  /** The name that the browser saves the file as. */
  filename: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface Services {
  /** R2 bucket for CSV uploads, error files, and exports. */
  bucket: R2Bucket;
  /** HMAC of a normalized address, for suppressions and `contacts.email_hash`. */
  hashEmail: EmailHasher;
  /** Starts the import Workflow for one run. */
  startImportJob(job: ImportJob): Promise<void>;
  /** Signs a download link for a file in the bucket. */
  signFileLink(file: FileLinkRequest): Promise<string>;
  /** Encrypts provider credentials and webhook secrets (R11). Needs ENCRYPTION_KEY. */
  credentials: CredentialCipher;
  /** Outbound HTTP to providers and to DNS over HTTPS. Tests pass a mock. */
  outboundFetch: typeof fetch;
  /** The public origin of this deployment, for webhook URLs. For example `https://mail.example.com`. */
  appOrigin: string;
}

/** Returns the service, or throws when the surface did not provide it. */
export function requireService<K extends keyof Services>(
  services: Partial<Services>,
  name: K,
): Services[K] {
  const service = services[name];
  if (service === undefined) throw new Error(`The ${name} service is not configured.`);
  return service as Services[K];
}
