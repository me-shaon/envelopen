import type { CredentialCipher } from "./crypto/credentials";
import type { WelcomeRunner } from "./welcome/start";

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

/** A campaign that the snapshot Workflow builds and dispatches (U9). */
export interface CampaignJob {
  workspaceId: number;
  campaignId: number;
  /** `campaigns.started_at`, so each start of a campaign has its own Workflow instance. */
  startedAt: number;
}

/** A backup run that the backup Workflow executes (U4). */
export interface BackupJob {
  /** `backup_runs.id`. */
  runId: number;
  /** `backup_runs.backup_id`, the R2 folder name. */
  backupId: string;
}

/** A passphrase key derivation that the key derivation Workflow runs in steps (U4). */
/** One instance of the restore Workflow (U5). */
export interface RestoreJob {
  /** `restore_runs.id`. */
  runId: number;
  /** `restore_runs.generation`. A long restore goes on in a new instance with the next one. */
  generation: number;
}

export interface KeyDerivationJob {
  /** `key_derivations.id`. */
  derivationId: number;
  /** The number of PBKDF2 segments, one per step. */
  segments: number;
}

/**
 * A queue message: a pointer to one batch (KTD17). The database holds all recipient
 * state. A message whose generation differs from the batch's is stale.
 */
export interface BatchPointer {
  v: 1;
  workspaceId: number;
  campaignId: number;
  batchId: number;
  generation: number;
}

/** The send queue, as the engine uses it. The Worker wraps `SEND_QUEUE`. */
export interface SendQueue {
  /** Sends the pointers, at most 100 per call to the platform. */
  send(pointers: readonly BatchPointer[]): Promise<void>;
}

/** The D1 daily limit stopped writes (KTD24). Kept in the UsageMeter Durable Object. */
export interface PlatformLimit {
  /** When the limit resets: the next 00:00 UTC. */
  until: number;
  since: number;
}

export interface UsageStatus {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  /** D1 rows written today, as the metered binding measured them. */
  rowsWritten: number;
  /** The Workers Free daily limit of D1 rows written. */
  dailyLimit: number;
  /** The part of `rowsWritten` that welcome steps reported (KTD9). */
  automationRows?: number;
  platformLimit: PlatformLimit | null;
  /**
   * True while the UnsubscribeLedger holds unsubscribes that D1 rejected at its daily
   * limit (KTD1). Send paths then ask the ledger which contacts to skip.
   */
  unsubscribesPending?: boolean;
}

/** Reads the UsageMeter Durable Object. */
export interface UsageReader {
  status(): Promise<UsageStatus>;
}

/** A link to a file in R2 that works without a session until it expires. */
export interface FileLinkRequest {
  key: string;
  /** The name that the browser saves the file as. */
  filename: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * A read-mostly cache of deployment settings, for the public pages (KTD16). The Worker
 * backs it with KV. Values expire on their own, so a missed write heals itself.
 */
export interface SettingsCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
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
  /** Starts the campaign snapshot Workflow (U9). */
  startCampaignJob(job: CampaignJob): Promise<void>;
  /** Puts batch pointers on the send queue (U9). */
  sendQueue: SendQueue;
  /** The daily D1 usage and the platform_limit flag (KTD24). */
  usage: UsageReader;
  /** The cache that the public pages read deployment settings from. */
  settingsCache: SettingsCache;
  /** Starts the backup Workflow for one run (U4). */
  startBackupJob(job: BackupJob): Promise<void>;
  /** Starts the key derivation Workflow for one passphrase (U4). */
  startKeyDerivation(job: KeyDerivationJob): Promise<void>;
  /** True when TURNSTILE_SITE_KEY and TURNSTILE_SECRET are set, so forms take signups (U8). */
  turnstileConfigured: boolean;
  /** Starts and stops welcome series instances (U10). The Worker wraps WELCOME_WORKFLOW. */
  welcome: WelcomeRunner;
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
