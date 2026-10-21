import type { DbConnection, Row } from "@envelopen/db";
import type { CredentialCipher, CredentialOwner } from "../crypto/credentials";
import { OperationError } from "../errors";
import type { KeyDerivationJob } from "../services";
import {
  BACKUP_KDF_ITERATIONS,
  BackupCryptoError,
  type BackupKeyMaterial,
  fromBase64Url,
  keysFromMaster,
  PBKDF2_SEGMENT_ITERATIONS,
  passphraseProblem,
  pbkdf2Segment,
  privateKeyFromMaster,
  segmentCount,
  segmentIterations,
  toBase64Url,
  VERIFIER_ITERATIONS,
} from "./crypto";
import { writeBackupSettings } from "./model";

// Passphrase key derivation in steps (U4, KTD2).
//
// PBKDF2-SHA256 with 600,000 iterations takes about 40 ms of CPU. Workers Free gives a
// request and a Workflow step 10 ms each. So a request never derives the key. It stores
// the passphrase sealed and starts the key derivation Workflow
// (apps/worker/src/workflows/key-derivation-workflow.ts), which runs:
//
//   segment 1 .. segment 6   one PBKDF2 call of 100,000 iterations each (about 7 ms)
//   finish                   the X25519 key pair and the verifier (1,000 iterations)
//
// The steps pass no secret in the Workflow state. The `key_derivations` row carries the
// passphrase and the chained PBKDF2 value, each sealed with ENCRYPTION_KEY (the
// credentials cipher) and bound to the row id and its role. The end of the derivation,
// success or failure, clears both. The output is the same as the one-shot
// `chainedPbkdf2` in crypto.ts.
//
// Purposes:
// - setup: a new passphrase. The finish step stores the key material in
//   backup_settings, unless a newer setup derivation started.
// - unwrap: U5 restore and download. The finish step checks the verifier and the public
//   key of the backup, and stores the derivation output sealed. `openDerivedPrivateKey`
//   gives the private key for `unwrapWithPrivateKey`, then the caller clears it with
//   `clearDerivationResult`.

/** A pending derivation older than this is failed and its secrets are cleared. */
export const DERIVATION_TTL_MS = 60 * 60 * 1000;

export type KeyDerivationRow = Row<"key_derivations">;

type SealRole = "derivation_secret" | "derivation_state" | "derivation_result";

function owner(id: number, role: SealRole): CredentialOwner {
  return { workspaceId: 0, purpose: role, connectionId: id };
}

async function seal(cipher: CredentialCipher, id: number, role: SealRole, bytes: Uint8Array) {
  return cipher.encrypt(toBase64Url(bytes), owner(id, role));
}

async function unseal(
  cipher: CredentialCipher,
  row: KeyDerivationRow,
  role: SealRole,
  value: string | null,
): Promise<Uint8Array> {
  if (value === null || row.key_version === null) {
    throw new BackupCryptoError("The derivation state is missing.");
  }
  return fromBase64Url(await cipher.decrypt(value, row.key_version, owner(row.id, role)));
}

const SECRETS_CLEARED = { sealed_secret: null, sealed_state: null } as const;

export type KeyDerivationInput =
  | {
      purpose: "setup";
      passphrase: string;
      /** Fixed salts for tests. Random by default. */
      salt?: Uint8Array;
      verifierSalt?: Uint8Array;
      iterations?: number;
    }
  | {
      purpose: "unwrap";
      passphrase: string;
      /** The key material of the backup to open (Manifest.keyMaterial). */
      material: BackupKeyMaterial;
    };

/**
 * Stores a new derivation with the passphrase sealed, and returns the job for the key
 * derivation Workflow. It does no PBKDF2 work.
 */
export async function beginKeyDerivation(
  db: DbConnection,
  cipher: CredentialCipher,
  input: KeyDerivationInput,
  now: number,
): Promise<KeyDerivationJob> {
  const problem = passphraseProblem(input.passphrase);
  if (problem) throw new OperationError("invalid_input", problem);
  const values =
    input.purpose === "setup"
      ? {
          kdf_salt: toBase64Url(input.salt ?? crypto.getRandomValues(new Uint8Array(16))),
          kdf_iterations: input.iterations ?? BACKUP_KDF_ITERATIONS,
          verifier_salt: toBase64Url(
            input.verifierSalt ?? crypto.getRandomValues(new Uint8Array(16)),
          ),
          verifier_iterations: VERIFIER_ITERATIONS,
          public_key: null,
          verifier: null,
        }
      : {
          kdf_salt: input.material.kdfSalt,
          kdf_iterations: input.material.kdfIterations,
          verifier_salt: input.material.verifierSalt,
          verifier_iterations: input.material.verifierIterations,
          public_key: input.material.publicKey,
          verifier: input.material.verifier,
        };
  const row = await db.db
    .insertInto("key_derivations")
    .values({ purpose: input.purpose, created_at: now, ...values })
    .returning(["id", "kdf_iterations"])
    .executeTakeFirstOrThrow();
  await db.db
    .updateTable("key_derivations")
    .set({
      sealed_secret: await seal(
        cipher,
        row.id,
        "derivation_secret",
        new TextEncoder().encode(input.passphrase),
      ),
      key_version: cipher.version,
    })
    .where("id", "=", row.id)
    .execute();
  return { derivationId: row.id, segments: segmentCount(row.kdf_iterations) };
}

/** Begins a derivation and starts its Workflow. A failed start fails the derivation. */
export async function startKeyDerivation(
  db: DbConnection,
  cipher: CredentialCipher,
  start: (job: KeyDerivationJob) => Promise<void>,
  input: KeyDerivationInput,
  now: number,
): Promise<KeyDerivationJob> {
  const job = await beginKeyDerivation(db, cipher, input, now);
  try {
    await start(job);
  } catch (error) {
    await failKeyDerivation(db, job, "The key derivation could not start.", now);
    throw error;
  }
  return job;
}

async function derivationRow(db: DbConnection, id: number) {
  return db.db.selectFrom("key_derivations").selectAll().where("id", "=", id).executeTakeFirst();
}

export type SegmentOutcome = { kind: "stop" } | { kind: "done"; iterations: number };

/**
 * One step: segment `index` (1-based) of the chained PBKDF2. A step that already ran
 * (a Workflow retry after the write) does nothing.
 */
export async function deriveSegment(
  db: DbConnection,
  cipher: CredentialCipher,
  job: KeyDerivationJob,
  index: number,
): Promise<SegmentOutcome> {
  const row = await derivationRow(db, job.derivationId);
  if (row?.status !== "pending") return { kind: "stop" };
  const count = segmentIterations(row.kdf_iterations, index);
  const startAt = (index - 1) * PBKDF2_SEGMENT_ITERATIONS;
  if (count <= 0) throw new BackupCryptoError(`The derivation has no segment ${index}.`);
  if (row.done_iterations > startAt) return { kind: "done", iterations: 0 };
  if (row.done_iterations < startAt) {
    throw new BackupCryptoError(`Segment ${index} runs before the segment it needs.`);
  }
  const secret = await unseal(cipher, row, "derivation_secret", row.sealed_secret);
  const previous =
    index === 1
      ? new Uint8Array(0)
      : await unseal(cipher, row, "derivation_state", row.sealed_state);
  const next = await pbkdf2Segment(secret, fromBase64Url(row.kdf_salt), index, previous, count);
  await db.db
    .updateTable("key_derivations")
    .set({
      sealed_state: await seal(cipher, row.id, "derivation_state", next),
      done_iterations: startAt + count,
    })
    .where("id", "=", row.id)
    .where("done_iterations", "=", startAt)
    .execute();
  return { kind: "done", iterations: count };
}

export type FinishDerivationOutcome = { status: "ready" | "failed" | "stopped" | "superseded" };

/** The last step: the key pair and the verifier. Clears the sealed passphrase and state. */
export async function finishKeyDerivation(
  db: DbConnection,
  cipher: CredentialCipher,
  job: KeyDerivationJob,
  now: number,
): Promise<FinishDerivationOutcome> {
  const row = await derivationRow(db, job.derivationId);
  if (row?.status !== "pending") return { status: "stopped" };
  if (row.done_iterations !== row.kdf_iterations) {
    throw new BackupCryptoError("The derivation has segments left.");
  }
  const master = await unseal(cipher, row, "derivation_state", row.sealed_state);
  const keys = await keysFromMaster(
    master,
    fromBase64Url(row.verifier_salt),
    row.verifier_iterations,
  );
  const publicKey = toBase64Url(keys.publicKey);
  const verifier = toBase64Url(keys.verifier);

  if (row.purpose === "unwrap") {
    const material: BackupKeyMaterial = {
      publicKey: row.public_key ?? "",
      kdfSalt: row.kdf_salt,
      kdfIterations: row.kdf_iterations,
      verifier: row.verifier ?? "",
      verifierSalt: row.verifier_salt,
      verifierIterations: row.verifier_iterations,
    };
    try {
      await privateKeyFromMaster(master, material);
    } catch (error) {
      await failKeyDerivation(db, job, (error as Error).message, now);
      return { status: "failed" };
    }
    await db.db
      .updateTable("key_derivations")
      .set({
        ...SECRETS_CLEARED,
        status: "ready",
        finished_at: now,
        sealed_result: await seal(cipher, row.id, "derivation_result", master),
      })
      .where("id", "=", row.id)
      .execute();
    return { status: "ready" };
  }

  // A newer setup derivation wins, so an older one that ends later does not overwrite it.
  const newer = await db.db
    .selectFrom("key_derivations")
    .select("id")
    .where("purpose", "=", "setup")
    .where("id", ">", row.id)
    .limit(1)
    .executeTakeFirst();
  await db.db
    .updateTable("key_derivations")
    .set({ ...SECRETS_CLEARED, status: "ready", finished_at: now, public_key: publicKey, verifier })
    .where("id", "=", row.id)
    .execute();
  if (newer) return { status: "superseded" };
  await writeBackupSettings(
    db,
    {
      public_key: publicKey,
      kdf_salt: row.kdf_salt,
      kdf_iterations: row.kdf_iterations,
      verifier,
      verifier_salt: row.verifier_salt,
      verifier_iterations: row.verifier_iterations,
      key_set_at: now,
    },
    now,
  );
  return { status: "ready" };
}

/** Marks the derivation failed and clears every sealed value. */
export async function failKeyDerivation(
  db: DbConnection,
  job: KeyDerivationJob,
  error: string,
  now: number,
): Promise<void> {
  await db.db
    .updateTable("key_derivations")
    .set({
      ...SECRETS_CLEARED,
      sealed_result: null,
      status: "failed",
      error: error.slice(0, 300),
      finished_at: now,
    })
    .where("id", "=", job.derivationId)
    .where("status", "=", "pending")
    .execute();
}

/**
 * For U5: the private key of a finished unwrap derivation. Pass it to
 * `unwrapWithPrivateKey`, then call `clearDerivationResult`.
 */
export async function openDerivedPrivateKey(
  db: DbConnection,
  cipher: CredentialCipher,
  derivationId: number,
): Promise<{ privateKey: CryptoKey; material: BackupKeyMaterial }> {
  const row = await derivationRow(db, derivationId);
  if (row?.purpose !== "unwrap" || row.status !== "ready" || !row.sealed_result) {
    throw new BackupCryptoError("The key derivation is not ready.");
  }
  const material: BackupKeyMaterial = {
    publicKey: row.public_key ?? "",
    kdfSalt: row.kdf_salt,
    kdfIterations: row.kdf_iterations,
    verifier: row.verifier ?? "",
    verifierSalt: row.verifier_salt,
    verifierIterations: row.verifier_iterations,
  };
  const master = await unseal(cipher, row, "derivation_result", row.sealed_result);
  return { privateKey: await privateKeyFromMaster(master, material), material };
}

export async function clearDerivationResult(db: DbConnection, derivationId: number) {
  await db.db
    .updateTable("key_derivations")
    .set({ sealed_result: null })
    .where("id", "=", derivationId)
    .execute();
}

/**
 * Fails derivations that stayed pending past DERIVATION_TTL_MS (a stopped Workflow) and
 * clears unwrap results that nobody picked up. The cron runs it once an hour.
 */
export async function expireKeyDerivations(db: DbConnection, now: number): Promise<number> {
  const cutoff = now - DERIVATION_TTL_MS;
  const failed = await db.db
    .updateTable("key_derivations")
    .set({
      ...SECRETS_CLEARED,
      sealed_result: null,
      status: "failed",
      error: "The key derivation did not finish in time.",
      finished_at: now,
    })
    .where("status", "=", "pending")
    .where("created_at", "<", cutoff)
    .executeTakeFirst();
  await db.db
    .updateTable("key_derivations")
    .set({ sealed_result: null })
    .where("sealed_result", "is not", null)
    .where("created_at", "<", cutoff)
    .execute();
  return Number(failed.numUpdatedRows);
}

// The driver ----------------------------------------------------------------------------

export interface DerivationRunner {
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export interface DerivationSteps {
  segment(index: number): Promise<SegmentOutcome>;
  finish(): Promise<FinishDerivationOutcome>;
  fail(error: string): Promise<void>;
}

/**
 * Runs one derivation, one segment per step, then the finish step. An error marks the
 * derivation failed. Returns the end state.
 */
export async function driveKeyDerivation(
  runner: DerivationRunner,
  steps: DerivationSteps,
  job: KeyDerivationJob,
): Promise<string> {
  try {
    for (let index = 1; index <= job.segments; index++) {
      const outcome = await runner.step(`segment ${index}`, () => steps.segment(index));
      if (outcome.kind === "stop") return "stopped";
    }
    return (await runner.step("finish", () => steps.finish())).status;
  } catch (error) {
    console.error("Key derivation failed", job, error);
    await runner.step("mark failed", () =>
      steps.fail("The key derivation stopped on an error. Try again."),
    );
    return "failed";
  }
}

/** The steps of one derivation on a connection that `withDb` gives per step. */
export function keyDerivationSteps(
  withDb: <T>(
    work: (db: DbConnection, cipher: CredentialCipher, now: number) => Promise<T>,
  ) => Promise<T>,
  job: KeyDerivationJob,
): DerivationSteps {
  return {
    segment: (index) => withDb((db, cipher) => deriveSegment(db, cipher, job, index)),
    finish: () => withDb((db, cipher, now) => finishKeyDerivation(db, cipher, job, now)),
    fail: (error) => withDb((db, _cipher, now) => failKeyDerivation(db, job, error, now)),
  };
}
