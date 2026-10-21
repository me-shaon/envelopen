import {
  ARCHIVE_EXTENSION,
  archiveSize,
  BACKUP_SCHEMA_VERSION,
  beginRestore,
  estimateRestoreDays,
  failRestore,
  isOperationError,
  MAX_PASSPHRASE_LENGTH,
  type Manifest,
  parseManifest,
  passphraseProblem,
  RESTORE_UPLOAD_PREFIX,
  r2ArchiveSource,
  r2FolderSource,
  readRestoreStatus,
  schemaProblem,
} from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type AttemptLimiter,
  attemptKeys,
  clientIp,
  RESTORE_PASSPHRASE_KEY,
  RESTORE_PASSPHRASE_RULE,
  RESTORE_RULE,
  SETUP_RULE,
} from "../auth/rate-limit-do";
import { defaultLimiter, tooManyAttempts } from "../auth/routes";
import { readBodyLimited } from "../body";
import { createServices, restoreStarter } from "../services";
import {
  fail,
  notFound,
  readOwnerId,
  runSetupChecks,
  type SetupAppEnv,
  type SetupRoutesOptions,
  setupTokenConfigured,
  setupTokenMatches,
} from "./first-run";

// Restore from the first-run screen (U5, KTD3, R3). Mounted at /api/setup/restore.
//
//   POST /status    { token }                          The newest restore and its progress.
//   POST /sources   { token }                          Backups in this deployment's R2.
//   POST /upload    archive bytes, X-Setup-Token header Stores a .envbak file for a restore.
//   POST /start     { token, source, passphrase }      Starts the restore Workflow.
//
// Restore works only before an owner exists, so it can never overwrite data: KTD3
// restores the global rows of the backup as they are. Every route answers 404 when
// SETUP_TOKEN is unset, and once the owner exists, except /status after a restore, so
// the screen can show the summary. Wrong tokens count per IP, as for the other setup
// routes. Restore starts and uploads count per IP too. Five wrong passphrases in an hour
// lock every restore start of the deployment for the rest of the hour.

/** Workers accept request bodies of up to 100 MB. The file must fit in one request. */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
/** The R2 backups that /sources reads the manifests of, at most. */
const MAX_SOURCES = 60;
const BACKUP_ID = z.string().regex(/^[0-9a-f-]{36}$/);

const StartBody = z.object({
  token: z.string().max(1024),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("r2"), backupId: BACKUP_ID }),
    z.object({ kind: z.literal("upload"), uploadId: BACKUP_ID }),
  ]),
  passphrase: z.string().max(MAX_PASSPHRASE_LENGTH),
});

export interface BackupSummary {
  backupId: string;
  createdAt: number;
  schemaVersion: number;
  totalRows: number;
  chunkCount: number;
  sizeBytes: number;
  /** Days of the Workers Free write limit that the restore needs, at an estimate. */
  estimatedDays: number;
  /** Why this deployment cannot restore it, or null. */
  problem: string | null;
}

function summaryOf(manifest: Manifest, manifestBytes: number): BackupSummary {
  return {
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    totalRows: manifest.totalRows,
    chunkCount: manifest.chunks.length,
    sizeBytes: archiveSize(manifest, manifestBytes),
    estimatedDays: estimateRestoreDays(manifest.totalRows),
    problem: schemaProblem(manifest.schemaVersion),
  };
}

function uploadKey(uploadId: string): string {
  return `${RESTORE_UPLOAD_PREFIX}${uploadId}${ARCHIVE_EXTENSION}`;
}

type Guarded =
  | { response: Response }
  | { body: Record<string, unknown>; conn: DbConnection; ownerId: string | null };

export function createRestoreRoutes(options: SetupRoutesOptions = {}): Hono<SetupAppEnv> {
  const limiterFor: (env: Env) => AttemptLimiter = options.limiter ?? defaultLimiter;
  const appOrigin = options.appOrigin ?? ((c) => new URL(c.req.url).origin);
  const app = new Hono<SetupAppEnv>();

  /** The closed screen, the origin, the owner state, the rate limit, and the token. */
  async function guard(
    c: Context<SetupAppEnv>,
    token: unknown,
    body: Record<string, unknown>,
    allowOwner: (conn: DbConnection) => Promise<boolean> = async () => false,
  ): Promise<Guarded> {
    const expected = c.env.SETUP_TOKEN;
    if (!setupTokenConfigured(expected)) return { response: notFound(c) };
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== appOrigin(c)) {
      return {
        response: fail(c, 403, "cross_origin", "This request must come from the Envelopen app."),
      };
    }
    const conn = createDb(c.env);
    const ownerId = await readOwnerId(conn);
    if (ownerId !== null && !(await allowOwner(conn))) return { response: notFound(c) };

    const limiter = limiterFor(c.env);
    const ipKey = attemptKeys.ip("setup", clientIp(c.req.raw));
    const status = await limiter.check(ipKey, SETUP_RULE);
    if (!status.allowed) return { response: tooManyAttempts(status) };
    if (!(await setupTokenMatches(expected, token))) {
      await limiter.record(ipKey, SETUP_RULE);
      return { response: fail(c, 401, "invalid_setup_token", "The setup token is not correct.") };
    }
    return { body, conn, ownerId };
  }

  async function jsonBody(c: Context<SetupAppEnv>): Promise<Record<string, unknown> | Response> {
    const bytes = await readBodyLimited(c.req.raw, MAX_JSON_BYTES);
    if (!bytes) return fail(c, 413, "too_large", "The request body is too large.");
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed !== "object" || parsed === null) throw new Error("Not an object.");
      return parsed as Record<string, unknown>;
    } catch {
      return fail(c, 400, "invalid_input", "Send a JSON object.");
    }
  }

  /** Counts a restore start or upload for the IP. Returns a 429 response when over. */
  async function countAttempt(c: Context<SetupAppEnv>): Promise<Response | null> {
    const status = await limiterFor(c.env).record(
      attemptKeys.ip("restore", clientIp(c.req.raw)),
      RESTORE_RULE,
    );
    return status.count > RESTORE_RULE.limit ? tooManyAttempts(status) : null;
  }

  app.post("/status", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    // After a restore the owner exists. The screen still shows the summary then.
    const result = await guard(c, body.token, body, async (conn) =>
      Boolean(await readRestoreStatus(conn)),
    );
    if ("response" in result) return result.response;
    return c.json({
      restore: await readRestoreStatus(result.conn),
      owner: result.ownerId !== null,
    });
  });

  app.post("/sources", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const result = await guard(c, body.token, body);
    if ("response" in result) return result.response;
    const listing = await c.env.BUCKET.list({ prefix: "backups/", delimiter: "/" });
    const backups: BackupSummary[] = [];
    for (const prefix of listing.delimitedPrefixes.slice(0, MAX_SOURCES)) {
      const backupId = prefix.slice("backups/".length, -1);
      if (!BACKUP_ID.safeParse(backupId).success) continue;
      try {
        const bytes = await r2FolderSource(c.env.BUCKET, backupId).manifestBytes();
        backups.push(summaryOf(parseManifest(bytes), bytes.length));
      } catch {
        // A backup without a manifest did not finish. It cannot be restored.
      }
    }
    backups.sort((a, b) => b.createdAt - a.createdAt);
    return c.json({
      backups,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
  });

  app.post("/upload", async (c) => {
    const result = await guard(c, c.req.header("x-setup-token"), {});
    if ("response" in result) return result.response;
    const limited = await countAttempt(c);
    if (limited) return limited;
    const length = Number(c.req.header("content-length") ?? Number.NaN);
    if (!Number.isSafeInteger(length) || length <= 0) {
      return fail(c, 411, "length_required", "Send the file with its Content-Length.");
    }
    if (length > MAX_UPLOAD_BYTES) {
      return fail(
        c,
        413,
        "too_large",
        "The backup file is larger than one upload can take. Restore it from R2: copy the backup folder into the bucket of this deployment.",
      );
    }
    const raw = c.req.raw.body;
    if (!raw) return fail(c, 400, "invalid_input", "Send the backup file.");
    const uploadId = crypto.randomUUID();
    const key = uploadKey(uploadId);
    const fixed = new FixedLengthStream(length);
    const piped = raw.pipeTo(fixed.writable);
    await Promise.all([
      c.env.BUCKET.put(key, fixed.readable, {
        httpMetadata: { contentType: "application/octet-stream" },
      }),
      piped,
    ]);
    try {
      const source = r2ArchiveSource(c.env.BUCKET, key);
      const bytes = await source.manifestBytes();
      const manifest = parseManifest(bytes);
      if (archiveSize(manifest, bytes.length) !== length) {
        throw new Error("The backup file is not complete.");
      }
      return c.json({ uploadId, backup: summaryOf(manifest, bytes.length) }, 201);
    } catch (error) {
      await c.env.BUCKET.delete(key);
      return fail(
        c,
        400,
        "invalid_backup",
        error instanceof Error ? error.message : "The file is not an Envelopen backup.",
      );
    }
  });

  app.post("/start", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const result = await guard(c, body.token, body);
    if ("response" in result) return result.response;
    const { conn } = result;
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, "invalid_input", "The input is not valid.", parsed.error.issues);
    }
    const input = parsed.data;
    const problem = passphraseProblem(input.passphrase);
    if (problem) return fail(c, 400, "invalid_input", problem);

    const limiter = limiterFor(c.env);
    const locked = await limiter.check(RESTORE_PASSPHRASE_KEY, RESTORE_PASSPHRASE_RULE);
    if (!locked.allowed) {
      return fail(
        c,
        429,
        "restore_locked",
        "Restore is locked after too many wrong passphrases. Try again in an hour.",
        { retryAfterMs: locked.retryAfterMs },
      );
    }
    const limited = await countAttempt(c);
    if (limited) return limited;

    const checks = await runSetupChecks(c.env);
    if (!checks.every((item) => item.ok)) {
      return fail(c, 409, "setup_checks_failed", "Fix the failed checks first.", checks);
    }
    const services = createServices(c.env);
    if (!services.credentials) {
      return fail(c, 409, "setup_checks_failed", "Set the ENCRYPTION_KEY secret first.");
    }

    const source =
      input.source.kind === "r2"
        ? { source: "r2" as const, sourceKey: input.source.backupId }
        : { source: "upload" as const, sourceKey: uploadKey(input.source.uploadId) };
    let manifest: Manifest;
    try {
      const reader =
        source.source === "r2"
          ? r2FolderSource(c.env.BUCKET, source.sourceKey)
          : r2ArchiveSource(c.env.BUCKET, source.sourceKey);
      manifest = parseManifest(await reader.manifestBytes());
    } catch (error) {
      return fail(
        c,
        400,
        "invalid_backup",
        error instanceof Error ? error.message : "The backup cannot be read.",
      );
    }

    const now = Date.now();
    let started: Awaited<ReturnType<typeof beginRestore>>;
    try {
      started = await beginRestore(
        conn,
        services.credentials,
        { ...source, manifest, passphrase: input.passphrase, ip: clientIp(c.req.raw) },
        now,
      );
    } catch (error) {
      if (isOperationError(error)) {
        const status = error.code === "conflict" ? 409 : 400;
        return fail(c, status, error.code, error.message);
      }
      throw error;
    }
    try {
      await restoreStarter(c.env)(started.job);
    } catch (error) {
      console.error("The restore Workflow did not start", error);
      await failRestore(
        conn,
        started.job,
        "start",
        "The restore could not start. Try again.",
        "failed",
        now,
      );
      return fail(c, 503, "restore_not_started", "The restore could not start. Try again.");
    }
    return c.json({ restore: await readRestoreStatus(conn) }, 202);
  });

  app.all("*", (c) => notFound(c));
  return app;
}
