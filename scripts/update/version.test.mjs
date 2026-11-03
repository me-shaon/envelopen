import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { editJsonc, parseJsonc } from "./jsonc.mjs";
import { changelogSection, compareVersions, currentVersion, VERSION_FILE } from "./version.mjs";

describe("compareVersions", () => {
  it("orders versions by number, not by text", () => {
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  });

  it("rejects text that is not a version", () => {
    assert.throws(() => compareVersions("latest", "1.0.0"), /Not a semantic version/);
  });
});

describe("changelogSection", () => {
  const changelog = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-01

### Added

- A thing.

## [0.1.0] - 2026-10-20

- First.

[0.2.0]: https://example.test/0.2.0
`;

  it("returns the body of one version", () => {
    assert.equal(changelogSection(changelog, "v0.2.0"), "### Added\n\n- A thing.");
    assert.equal(changelogSection(changelog, "0.1.0"), "- First.");
    assert.equal(changelogSection(changelog, "9.9.9"), undefined);
  });
});

describe("jsonc", () => {
  it("reads comments and trailing commas", () => {
    const text = '{\n  // a\n  "a": [1, 2,], /* b */ "s": "x // not a comment",\n}';
    assert.deepEqual(parseJsonc(text).value, { a: [1, 2], s: "x // not a comment" });
  });

  it("keeps comments when it changes a value", () => {
    const text = '{\n  // keep me\n  "a": 1,\n  "b": [{ "x": 1 }]\n}\n';
    const out = editJsonc(text, { a: 2, b: [{ x: 1 }, { x: 2 }], c: true });
    assert.match(out, /\/\/ keep me/);
    assert.deepEqual(parseJsonc(out).value, { a: 2, b: [{ x: 1 }, { x: 2 }], c: true });
  });
});

describe("currentVersion", () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function copy(versionTs, pkgVersion) {
    const root = mkdtempSync(join(tmpdir(), "envelopen-version-"));
    roots.push(root);
    mkdirSync(join(root, "apps/worker/src"), { recursive: true });
    writeFileSync(join(root, VERSION_FILE), versionTs);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
    return root;
  }

  it("reads ENVELOPEN_VERSION, not the 0.0.0 of package.json", () => {
    const root = copy('export const ENVELOPEN_VERSION = "1.2.3";\n', "0.0.0");
    assert.equal(currentVersion(root), "1.2.3");
  });

  it("reads package.json for a copy of v0.5.0 or older", () => {
    const old = 'import { version } from "../../../package.json";\n';
    assert.equal(currentVersion(copy(old, "0.0.0")), "0.0.0");
  });

  it("matches the version of this repository", () => {
    assert.match(currentVersion("."), /^\d+\.\d+\.\d+$/);
  });
});
