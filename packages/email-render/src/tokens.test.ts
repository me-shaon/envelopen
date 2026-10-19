import { describe, expect, it } from "vitest";
import { testKey } from "../test/keys";
import { createTokenSigner, TOKEN_KEY_LABEL, TokenKeyError, tokenKeysFromEnv } from "./tokens";

const OLD = testKey(1);
const NEW = testKey(2);
const REF = { campaignId: 12, recipientId: 98_765 };

describe("recipient tokens (KTD28)", () => {
  it("round-trips the campaign and recipient, and is deterministic", async () => {
    const signer = await createTokenSigner([{ secret: NEW }]);
    const token = await signer.sign(REF);
    expect(token).toMatch(/^[A-Za-z0-9_-]{8}\.c\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect(await signer.sign(REF)).toBe(token);
    expect(await signer.verify(token)).toEqual({ ...REF, keyId: signer.keyId, retired: false });
  });

  it("fails when any character of the token changes", async () => {
    const signer = await createTokenSigner([{ secret: NEW }]);
    const token = await signer.sign(REF);
    for (let i = 0; i < token.length; i++) {
      if (token[i] === ".") continue;
      const changed = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
      expect(await signer.verify(changed), `position ${i}`).toBeNull();
    }
    expect(await signer.verify(`${token}x`)).toBeNull();
    expect(await signer.verify(token.replace(".c.", ".d."))).toBeNull();
    expect(await signer.verify("")).toBeNull();
    expect(await signer.verify("a.b.c.d.e")).toBeNull();
  });

  it("verifies a token signed with a retired key after a rotation", async () => {
    const before = await createTokenSigner([{ secret: OLD }]);
    const oldToken = await before.sign(REF);
    const after = await createTokenSigner(tokenKeysFromEnv(NEW, ` ${OLD} ,`));
    expect(after.keyId).not.toBe(before.keyId);
    expect(await after.verify(oldToken)).toEqual({ ...REF, keyId: before.keyId, retired: true });
    const newToken = await after.sign(REF);
    expect(newToken).not.toBe(oldToken);
    expect((await after.verify(newToken))?.retired).toBe(false);
    // Without the retired key, the old token fails.
    expect(await (await createTokenSigner([{ secret: NEW }])).verify(oldToken)).toBeNull();
  });

  it("gives a new label version its own key id, so the old label can retire", async () => {
    const v1 = await createTokenSigner([{ secret: NEW }]);
    const v2 = await createTokenSigner([
      { secret: NEW, label: "envelopen/tokens/v2" },
      { secret: NEW, label: TOKEN_KEY_LABEL },
    ]);
    expect(v2.keyId).not.toBe(v1.keyId);
    expect(await v2.verify(await v1.sign(REF))).toMatchObject({ ...REF, retired: true });
  });

  it("rejects short keys and bad ids", async () => {
    await expect(createTokenSigner([])).rejects.toThrow(TokenKeyError);
    await expect(createTokenSigner([{ secret: btoa("short") }])).rejects.toThrow(TokenKeyError);
    const signer = await createTokenSigner([{ secret: NEW }]);
    await expect(signer.sign({ campaignId: 0, recipientId: 1 })).rejects.toThrow(RangeError);
    await expect(signer.sign({ campaignId: 1, recipientId: 1.5 })).rejects.toThrow(RangeError);
  });
});
