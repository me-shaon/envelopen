import { describe, expect, it } from "vitest";
import { TEST_ENCRYPTION_KEY, testDb } from "../../test/fixtures";
import { createCredentialCipher } from "../crypto/credentials";
import { isOperationError } from "../errors";
import type { KeyDerivationJob } from "../services";
import {
  createKeyMaterial,
  fromBase64Url,
  generateDataKey,
  PBKDF2_SEGMENT_ITERATIONS,
  toBase64Url,
  unwrapWithPrivateKey,
  wrapForRecipient,
} from "./crypto";
import {
  beginKeyDerivation,
  clearDerivationResult,
  DERIVATION_TTL_MS,
  type DerivationRunner,
  driveKeyDerivation,
  expireKeyDerivations,
  type KeyDerivationInput,
  keyDerivationSteps,
  openDerivedPrivateKey,
} from "./derivation";
import { readBackupSettings } from "./model";

// The passphrase key derivation in steps (U4, KTD2): one PBKDF2 segment of at most
// 100,000 iterations per Workflow step, so each step fits the Workers Free CPU limit.

const PASSPHRASE = "a long backup passphrase";
const NOW = Date.UTC(2026, 9, 21, 9, 0);
const SALT = new Uint8Array(16).fill(3);
const VERIFIER_SALT = new Uint8Array(16).fill(4);

async function cipher() {
  return createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
}

async function row(id: number) {
  return testDb()
    .db.selectFrom("key_derivations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/** Runs the steps directly, and records how many iterations each segment step ran. */
async function derive(input: KeyDerivationInput, failAt?: string) {
  const c = await cipher();
  const job = await beginKeyDerivation(testDb(), c, input, NOW);
  const steps: { name: string; iterations: number; plainSeen: boolean }[] = [];
  const runner: DerivationRunner = {
    async step(name, work) {
      if (name === failAt) throw new Error("The step failed.");
      const result = await work();
      const stored = JSON.stringify(await row(job.derivationId));
      steps.push({
        name,
        iterations:
          typeof result === "object" && result !== null && "iterations" in result
            ? (result as { iterations: number }).iterations
            : 0,
        plainSeen: stored.includes(input.passphrase),
      });
      return result;
    },
  };
  const status = await driveKeyDerivation(
    runner,
    keyDerivationSteps((work) => work(testDb(), c, NOW), job),
    job,
  );
  return { job, status, steps, cipher: c };
}

describe("key derivation in steps", () => {
  it("gives the same key as the one-shot derivation, in steps of at most 100,000 iterations", async () => {
    const { job, status, steps } = await derive({
      purpose: "setup",
      passphrase: PASSPHRASE,
      salt: SALT,
      verifierSalt: VERIFIER_SALT,
    });
    expect(status).toBe("ready");
    expect(job.segments).toBe(6);
    const segments = steps.filter((step) => step.name.startsWith("segment"));
    expect(segments.map((step) => step.iterations)).toEqual(new Array(6).fill(100_000));
    for (const step of segments)
      expect(step.iterations).toBeLessThanOrEqual(PBKDF2_SEGMENT_ITERATIONS);
    // The passphrase is never stored in plain form, before or after the end.
    expect(steps.some((step) => step.plainSeen)).toBe(false);

    const oneShot = await createKeyMaterial(PASSPHRASE, {
      salt: SALT,
      verifierSalt: VERIFIER_SALT,
    });
    const settings = await readBackupSettings(testDb());
    expect(settings).toMatchObject({
      public_key: oneShot.publicKey,
      verifier: oneShot.verifier,
      kdf_iterations: 600_000,
    });
    // The sealed passphrase and state are deleted at the end.
    expect(await row(job.derivationId)).toMatchObject({
      status: "ready",
      done_iterations: 600_000,
      sealed_secret: null,
      sealed_state: null,
    });
  });

  it("splits a count that is not a multiple of 100,000", async () => {
    const { job, steps } = await derive({
      purpose: "setup",
      passphrase: PASSPHRASE,
      salt: SALT,
      verifierSalt: VERIFIER_SALT,
      iterations: 250_000,
    });
    expect(job.segments).toBe(3);
    expect(steps.filter((s) => s.name.startsWith("segment")).map((s) => s.iterations)).toEqual([
      100_000, 100_000, 50_000,
    ]);
    const oneShot = await createKeyMaterial(PASSPHRASE, {
      salt: SALT,
      verifierSalt: VERIFIER_SALT,
      iterations: 250_000,
    });
    expect((await row(job.derivationId)).public_key).toBe(oneShot.publicKey);
  });

  it("marks the derivation failed and clears the secrets when a step in the middle fails", async () => {
    const before = await readBackupSettings(testDb());
    const { job, status } = await derive(
      { purpose: "setup", passphrase: "another long passphrase" },
      "segment 3",
    );
    expect(status).toBe("failed");
    expect(await row(job.derivationId)).toMatchObject({
      status: "failed",
      done_iterations: 200_000,
      sealed_secret: null,
      sealed_state: null,
      error: expect.stringContaining("Try again"),
    });
    // The key in use does not change.
    expect((await readBackupSettings(testDb()))?.public_key ?? null).toBe(
      before?.public_key ?? null,
    );
  });

  it("repeats a segment step without effect after a retry", async () => {
    const c = await cipher();
    const job = await beginKeyDerivation(
      testDb(),
      c,
      { purpose: "setup", passphrase: PASSPHRASE },
      NOW,
    );
    const steps = keyDerivationSteps((work) => work(testDb(), c, NOW), job);
    expect(await steps.segment(1)).toEqual({ kind: "done", iterations: 100_000 });
    const state = (await row(job.derivationId)).sealed_state;
    expect(await steps.segment(1)).toEqual({ kind: "done", iterations: 0 });
    expect((await row(job.derivationId)).sealed_state).toBe(state);
    // A segment cannot run before the one it needs.
    await expect(steps.segment(3)).rejects.toThrow("before the segment");
  });

  it("unwraps for U5: the right passphrase opens a backup key, a wrong one fails", async () => {
    const material = await createKeyMaterial(PASSPHRASE, { iterations: 200_000 });
    const dataKey = generateDataKey();
    const wrapped = await wrapForRecipient(material.publicKey, "backup-x", {
      dataKey,
      secrets: {
        signingKey: null,
        signingKeysRetired: null,
        encryptionKey: null,
        suppressionKeyId: null,
      },
    });

    const good = await derive({ purpose: "unwrap", passphrase: PASSPHRASE, material });
    expect(good.status).toBe("ready");
    const opened = await openDerivedPrivateKey(testDb(), good.cipher, good.job.derivationId);
    const unwrapped = await unwrapWithPrivateKey(
      wrapped,
      "backup-x",
      opened.privateKey,
      fromBase64Url(material.publicKey),
    );
    expect(toBase64Url(unwrapped.dataKey)).toBe(toBase64Url(dataKey));
    await clearDerivationResult(testDb(), good.job.derivationId);
    expect((await row(good.job.derivationId)).sealed_result).toBeNull();

    const bad = await derive({
      purpose: "unwrap",
      passphrase: "not the right passphrase",
      material,
    });
    expect(bad.status).toBe("failed");
    expect(await row(bad.job.derivationId)).toMatchObject({
      status: "failed",
      error: "The passphrase is not correct.",
      sealed_result: null,
    });
  });

  it("rejects a short passphrase before it stores anything", async () => {
    const c = await cipher();
    const error = await beginKeyDerivation(
      testDb(),
      c,
      { purpose: "setup", passphrase: "too short" },
      NOW,
    ).catch((e: unknown) => e);
    expect(isOperationError(error) && error.code).toBe("invalid_input");
  });

  it("fails a derivation that stayed pending, and clears its secrets", async () => {
    const c = await cipher();
    const job: KeyDerivationJob = await beginKeyDerivation(
      testDb(),
      c,
      { purpose: "setup", passphrase: PASSPHRASE },
      NOW,
    );
    expect(
      await expireKeyDerivations(testDb(), NOW + DERIVATION_TTL_MS + 1),
    ).toBeGreaterThanOrEqual(1);
    expect(await row(job.derivationId)).toMatchObject({ status: "failed", sealed_secret: null });
  });
});
