import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUsableKey } from "./auth/better-auth";
import {
  forgetGeneratedSecretsForTesting,
  GENERATED_SECRET_KEYS,
  withGeneratedSecrets,
} from "./secrets";

const KEY_A = btoa(String.fromCharCode(...new Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Array(32).fill(2)));

async function clearStored() {
  await env.BUCKET.delete(Object.values(GENERATED_SECRET_KEYS));
  forgetGeneratedSecretsForTesting();
}

function envWith(values: Partial<Pick<Env, "SIGNING_KEY" | "ENCRYPTION_KEY">>) {
  return {
    BUCKET: env.BUCKET,
    SIGNING_KEY: values.SIGNING_KEY,
    ENCRYPTION_KEY: values.ENCRYPTION_KEY,
    SIGNING_KEYS_RETIRED: undefined as string | undefined,
  };
}

describe("generated secrets", () => {
  beforeEach(clearStored);
  afterEach(clearStored);

  it("keeps the secrets that are set, and reads nothing for them", async () => {
    const filled = await withGeneratedSecrets(
      envWith({ SIGNING_KEY: KEY_A, ENCRYPTION_KEY: KEY_B }),
    );
    expect(filled.SIGNING_KEY).toBe(KEY_A);
    expect(filled.ENCRYPTION_KEY).toBe(KEY_B);
    expect(filled.SIGNING_KEYS_RETIRED).toBeUndefined();
    expect(await env.BUCKET.head(GENERATED_SECRET_KEYS.ENCRYPTION_KEY)).toBeNull();
    expect(await env.BUCKET.head(GENERATED_SECRET_KEYS.SIGNING_KEY)).toBeNull();
  });

  it("makes a usable key for each missing secret and keeps it in R2", async () => {
    const filled = await withGeneratedSecrets(envWith({}));
    expect(isUsableKey(filled.SIGNING_KEY)).toBe(true);
    expect(isUsableKey(filled.ENCRYPTION_KEY)).toBe(true);
    expect(filled.SIGNING_KEY).not.toBe(filled.ENCRYPTION_KEY);
    const stored = await env.BUCKET.get(GENERATED_SECRET_KEYS.SIGNING_KEY);
    expect(await stored?.text()).toBe(filled.SIGNING_KEY);
  });

  it("uses the stored value in a new isolate", async () => {
    const first = await withGeneratedSecrets(envWith({}));
    forgetGeneratedSecretsForTesting();
    const second = await withGeneratedSecrets(envWith({}));
    expect(second.SIGNING_KEY).toBe(first.SIGNING_KEY);
    expect(second.ENCRYPTION_KEY).toBe(first.ENCRYPTION_KEY);
  });

  it("does not replace a value that another isolate stored first", async () => {
    await env.BUCKET.put(GENERATED_SECRET_KEYS.ENCRYPTION_KEY, KEY_B);
    const filled = await withGeneratedSecrets(envWith({ SIGNING_KEY: KEY_A }));
    expect(filled.ENCRYPTION_KEY).toBe(KEY_B);
  });

  it("makes only the missing key", async () => {
    await withGeneratedSecrets(envWith({ SIGNING_KEY: KEY_A }));
    expect(await env.BUCKET.head(GENERATED_SECRET_KEYS.SIGNING_KEY)).toBeNull();
    expect(await env.BUCKET.head(GENERATED_SECRET_KEYS.ENCRYPTION_KEY)).not.toBeNull();
  });

  it("replaces a secret that is not a usable key, such as an old example value", async () => {
    const filled = await withGeneratedSecrets(
      envWith({ SIGNING_KEY: "replace-with-base64-32-byte-key", ENCRYPTION_KEY: KEY_B }),
    );
    expect(isUsableKey(filled.SIGNING_KEY)).toBe(true);
    expect(filled.SIGNING_KEY).not.toBe("replace-with-base64-32-byte-key");
  });

  it("retires the made SIGNING_KEY when the owner sets the secret later", async () => {
    const made = (await withGeneratedSecrets(envWith({ ENCRYPTION_KEY: KEY_B }))).SIGNING_KEY;
    forgetGeneratedSecretsForTesting();
    const later = await withGeneratedSecrets(
      envWith({ SIGNING_KEY: KEY_A, ENCRYPTION_KEY: KEY_B }),
    );
    expect(later.SIGNING_KEY).toBe(KEY_A);
    expect(later.SIGNING_KEYS_RETIRED).toBe(made);

    forgetGeneratedSecretsForTesting();
    const ring = await withGeneratedSecrets({
      ...envWith({ SIGNING_KEY: KEY_A, ENCRYPTION_KEY: KEY_B }),
      SIGNING_KEYS_RETIRED: `${KEY_B}, ${made}`,
    });
    expect(ring.SIGNING_KEYS_RETIRED).toBe(`${KEY_B}, ${made}`);
  });

  it("does not retire the made key when the secret has the same value", async () => {
    const made = (await withGeneratedSecrets(envWith({ ENCRYPTION_KEY: KEY_B }))).SIGNING_KEY;
    forgetGeneratedSecretsForTesting();
    const same = await withGeneratedSecrets(envWith({ SIGNING_KEY: made, ENCRYPTION_KEY: KEY_B }));
    expect(same.SIGNING_KEYS_RETIRED).toBeUndefined();
  });
});
