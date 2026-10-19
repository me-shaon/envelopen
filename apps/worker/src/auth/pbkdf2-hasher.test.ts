import { describe, expect, it } from "vitest";
import {
  createPasswordHasher,
  hashPassword,
  needsRehash,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  parseHash,
  resolveIterations,
  verifyPassword,
} from "./pbkdf2-hasher";

describe("PBKDF2 hasher", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery", 5_000);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("stores the algorithm, the iterations, and a random salt in the hash", async () => {
    const a = await hashPassword("same password", 5_000);
    const b = await hashPassword("same password", 5_000);
    expect(a).toMatch(/^\$pbkdf2-sha256\$i=5000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    const parsed = parseHash(a);
    expect(parsed?.iterations).toBe(5_000);
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.key).toHaveLength(32);
  });

  it("verifies with the iterations in the hash, not the current setting", async () => {
    const old = await hashPassword("pw-123456789", 2_000);
    const hasher = createPasswordHasher(PBKDF2_MAX_ITERATIONS);
    expect(await hasher.verify({ hash: old, password: "pw-123456789" })).toBe(true);
  });

  it("never verifies an unknown or broken hash format", async () => {
    for (const hash of [
      "",
      "plain",
      "salt:hex", // Better Auth's scrypt format
      "$pbkdf2-sha256$i=0$AAAA$AAAA",
      "$pbkdf2-sha256$i=100001$AAAA$AAAA",
      "$pbkdf2-sha1$i=1000$AAAA$AAAA",
      "$pbkdf2-sha256$i=1000$!!!$AAAA",
    ]) {
      expect(await verifyPassword("anything", hash), hash).toBe(false);
    }
  });

  it("asks for a rehash when the parameters differ", async () => {
    const hash = await hashPassword("pw-123456789", 2_000);
    expect(needsRehash(hash, 2_000)).toBe(false);
    expect(needsRehash(hash, 3_000)).toBe(true);
    expect(needsRehash("salt:hex", 2_000)).toBe(true);
  });

  it("reads the iteration count from the variable and clamps it", () => {
    expect(resolveIterations(undefined)).toBe(PBKDF2_DEFAULT_ITERATIONS);
    expect(resolveIterations("")).toBe(PBKDF2_DEFAULT_ITERATIONS);
    expect(resolveIterations("abc")).toBe(PBKDF2_DEFAULT_ITERATIONS);
    expect(resolveIterations("50000")).toBe(50_000);
    expect(resolveIterations("250000")).toBe(PBKDF2_MAX_ITERATIONS);
    expect(resolveIterations("10")).toBe(PBKDF2_MIN_ITERATIONS);
    expect(resolveIterations(75_000.9)).toBe(75_000);
  });
});

describe("Workers PBKDF2 limit", () => {
  async function derive(iterations: number) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pw"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations },
      key,
      256,
    );
  }

  // KTD7 says production Workers reject PBKDF2 above 100,000 iterations. Local workerd
  // accepts higher counts, so this test cannot prove the cap. The deployed benchmark
  // (scripts/pbkdf2-benchmark/) probes it. The hasher clamps to 100,000 either way.
  it("derives at the maximum count that the hasher uses", async () => {
    await expect(derive(PBKDF2_MAX_ITERATIONS)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(resolveIterations(String(PBKDF2_MAX_ITERATIONS + 1))).toBe(PBKDF2_MAX_ITERATIONS);
  });
});
