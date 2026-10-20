import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadSecrets, writeVarsFile } from "./secrets.mjs";

const dir = mkdtempSync(join(tmpdir(), "envelopen-demo-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const mode = (file) => statSync(file).mode & 0o777;

describe("demo secrets", () => {
  it("creates the secrets file readable by the owner only", () => {
    const file = join(dir, "secrets.json");
    const secrets = loadSecrets(file, () => ({ SIGNING_KEY: "a" }));
    assert.deepEqual(secrets, { SIGNING_KEY: "a" });
    assert.equal(mode(file), 0o600);
    // An existing file keeps its secrets and loses wider access.
    writeFileSync(file, '{"SIGNING_KEY":"b"}', { mode: 0o644 });
    assert.deepEqual(
      loadSecrets(file, () => ({})),
      { SIGNING_KEY: "b" },
    );
    assert.equal(mode(file), 0o600);
  });

  it("writes a private dotenv file for wrangler", () => {
    const file = join(dir, "demo.vars");
    writeVarsFile(file, { SIGNING_KEY: "abc+/=", SETUP_TOKEN: "f00" });
    assert.equal(readFileSync(file, "utf8"), 'SIGNING_KEY="abc+/="\nSETUP_TOKEN="f00"\n');
    assert.equal(mode(file), 0o600);
    assert.throws(() => writeVarsFile(file, { BAD: 'x"y' }));
  });
});
