import { describe, expect, it } from "vitest";
import { TEST_ENCRYPTION_KEY } from "../../test/fixtures";
import { CredentialKeyError, createCredentialCipher } from "./credentials";

const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const OWNER = { workspaceId: 1, purpose: "credentials" as const };

describe("credential encryption", () => {
  it("round-trips, and the stored value does not contain the plaintext", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const plaintext = JSON.stringify({ apiKey: "re_super_secret_value" });
    const sealed = await cipher.encrypt(plaintext, OWNER);
    expect(sealed).not.toContain("re_super_secret_value");
    expect(atob(sealed.split(".")[1] ?? "")).not.toContain("super_secret");
    expect(await cipher.decrypt(sealed, 1, OWNER)).toBe(plaintext);
  });

  it("uses a new IV each time", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    expect(await cipher.encrypt("same", OWNER)).not.toBe(await cipher.encrypt("same", OWNER));
  });

  it("fails with a wrong key, another workspace, another purpose, or a changed byte", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const wrong = await createCredentialCipher([{ version: 1, secret: OTHER_KEY }]);
    const sealed = await cipher.encrypt("secret", OWNER);
    await expect(wrong.decrypt(sealed, 1, OWNER)).rejects.toThrow(CredentialKeyError);
    await expect(
      cipher.decrypt(sealed, 1, { workspaceId: 2, purpose: "credentials" }),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(sealed, 1, { workspaceId: 1, purpose: "webhook_secret" }),
    ).rejects.toThrow();
    const [iv, body = ""] = sealed.split(".");
    const flipped = `${iv}.${body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`}`;
    await expect(cipher.decrypt(flipped, 1, OWNER)).rejects.toThrow();
    await expect(cipher.decrypt("not-a-ciphertext", 1, OWNER)).rejects.toThrow();
  });

  it("encrypts with the newest version and still decrypts older rows", async () => {
    const old = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const ring = await createCredentialCipher([
      { version: 1, secret: TEST_ENCRYPTION_KEY },
      { version: 2, secret: OTHER_KEY },
    ]);
    expect(ring.version).toBe(2);
    const legacy = await old.encrypt("v1 value", OWNER);
    expect(await ring.decrypt(legacy, 1, OWNER)).toBe("v1 value");
    await expect(ring.decrypt(legacy, 2, OWNER)).rejects.toThrow();
    await expect(old.decrypt(await ring.encrypt("v2", OWNER), 2, OWNER)).rejects.toThrow(
      /No key for version 2/,
    );
  });

  it("rejects a missing or short key", async () => {
    await expect(createCredentialCipher([])).rejects.toThrow(CredentialKeyError);
    await expect(createCredentialCipher([{ version: 1, secret: btoa("short") }])).rejects.toThrow(
      /32 bytes/,
    );
    await expect(
      createCredentialCipher([{ version: 0, secret: TEST_ENCRYPTION_KEY }]),
    ).rejects.toThrow();
  });
});
