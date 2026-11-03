// SIGNING_KEY and ENCRYPTION_KEY without setup. A secret set on the Worker wins. Without one,
// the Worker makes a random value on first use and keeps it in R2 under `secrets/`, so the
// Deploy button does not ask for them. The keys are in R2, not D1, so a D1 export alone does
// not hold both the encrypted provider credentials and the key that opens them.
//
// Each entry point calls withGeneratedSecrets: fetch, queue, scheduled, and the run of each
// Workflow. The Durable Objects do not read either key.
//
// When the owner sets SIGNING_KEY after the Worker made one, the made key goes on the
// SIGNING_KEYS_RETIRED ring. Links in emails that it signed keep working, and suppressions
// that it hashed keep matching (KTD28).
import { isUsableKey } from "./auth/better-auth";

/** The R2 object of each generated secret. Never delete one (README.md > Secrets). */
export const GENERATED_SECRET_KEYS = {
  SIGNING_KEY: "secrets/signing-key",
  ENCRYPTION_KEY: "secrets/encryption-key",
} as const;

type SecretName = keyof typeof GENERATED_SECRET_KEYS;
type SecretsEnv = Pick<Env, "BUCKET" | SecretName | "SIGNING_KEYS_RETIRED">;

const NAMES = Object.keys(GENERATED_SECRET_KEYS) as SecretName[];

/**
 * The values after the first successful read in this isolate. Only settled values are kept.
 * A pending read belongs to the request that started it: Workers cancel that I/O when the
 * request ends, so another request that awaited the same promise could wait forever.
 */
const generated: Partial<Record<SecretName, string>> = {};
/** The stored SIGNING_KEY when the secret is set too. "" when R2 has none. */
let storedSigningKey: string | undefined;

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

async function readStored(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object ? (await object.text()).trim() : null;
}

/**
 * The value in R2, made first when it is missing. "If-None-Match: *" stops a second isolate
 * from replacing a value that another isolate just made. The value is read back after the
 * write, so every isolate uses the stored value.
 */
async function readOrCreate(bucket: R2Bucket, key: string): Promise<string> {
  const existing = await readStored(bucket, key);
  if (existing) return existing;
  await bucket.put(key, randomSecret(), {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: "text/plain" },
  });
  const stored = await readStored(bucket, key);
  if (!stored) throw new Error(`Could not store the generated secret ${key} in R2`);
  return stored;
}

/** The retired ring with `key` added, unless the ring or SIGNING_KEY has it already. */
function withRetired(
  retired: string | undefined,
  current: string,
  key: string,
): string | undefined {
  const ring = (retired ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (key === current.trim() || ring.includes(key)) return retired;
  return [...ring, key].join(",");
}

/**
 * `env` with a generated value for each of SIGNING_KEY and ENCRYPTION_KEY that is missing
 * or not usable. When R2 fails, the env stays as it is: the first-run screen then reports
 * the missing key, and the next call tries R2 again.
 */
export async function withGeneratedSecrets<E extends SecretsEnv>(env: E): Promise<E> {
  if (!env.BUCKET) return env;
  const missing = NAMES.filter((name) => !isUsableKey(env[name]));
  const filled = { ...env };
  try {
    for (const name of missing) {
      generated[name] ??= await readOrCreate(env.BUCKET, GENERATED_SECRET_KEYS[name]);
      filled[name] = generated[name];
    }
    if (!missing.includes("SIGNING_KEY") && env.SIGNING_KEY) {
      storedSigningKey ??= (await readStored(env.BUCKET, GENERATED_SECRET_KEYS.SIGNING_KEY)) ?? "";
      if (storedSigningKey) {
        filled.SIGNING_KEYS_RETIRED = withRetired(
          env.SIGNING_KEYS_RETIRED,
          env.SIGNING_KEY,
          storedSigningKey,
        );
      }
    }
  } catch (error) {
    console.error("Could not read the generated secrets in R2", error);
    return env;
  }
  return filled;
}

/** Tests only: forgets the values read in this isolate. */
export function forgetGeneratedSecretsForTesting(): void {
  for (const name of NAMES) delete generated[name];
  storedSigningKey = undefined;
}
