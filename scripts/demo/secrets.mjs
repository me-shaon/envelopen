// The demo's secrets on disk. Both files are readable by the owner only, and wrangler
// reads the secrets from a vars file, so they never appear in a process list.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PRIVATE = 0o600;

/** Writes a file that only its owner can read, also when it existed with wider access. */
export function writePrivateFile(file, text) {
  writeFileSync(file, text, { mode: PRIVATE });
  chmodSync(file, PRIVATE);
}

/** Reads the secrets file, or creates it with `make()`. Tightens an older file's mode. */
export function loadSecrets(file, make) {
  if (!existsSync(file)) writePrivateFile(file, `${JSON.stringify(make(), null, 2)}\n`);
  else chmodSync(file, PRIVATE);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Writes the variables as a dotenv file for `wrangler dev --env-file`. */
export function writeVarsFile(file, vars) {
  const lines = Object.entries(vars).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /["\n\r\\]/.test(String(value))) {
      throw new Error(`The demo variable ${key} cannot go in a vars file.`);
    }
    return `${key}="${value}"`;
  });
  writePrivateFile(file, `${lines.join("\n")}\n`);
}
