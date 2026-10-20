import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { checkMigrations, latestReleaseTag } from "./check-migrations.mjs";

const WRANGLER = (migrations) => `{
  // A comment, as in the real file.
  "d1_databases": [{ "binding": "DB", "migrations_dir": "db/migrations" }],
  "migrations": ${JSON.stringify(migrations)},
}
`;
const V1 = { tag: "v1", new_sqlite_classes: ["A"] };
const V2 = { tag: "v2", new_sqlite_classes: ["B"] };

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let repo;
function git(...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    { cwd: repo, encoding: "utf8" },
  );
}
function write(path, content) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "envelopen-migrations-"));
  roots.push(repo);
  git("init", "-q");
  write("wrangler.jsonc", WRANGLER([V1, V2]));
  write("db/migrations/0001_initial.sql", "CREATE TABLE a (id INTEGER);\n");
  write("db/migrations/0002_more.sql", "CREATE TABLE b (id INTEGER);\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

describe("check-migrations", () => {
  it("skips with a notice when no release tag exists", () => {
    const result = checkMigrations({ cwd: repo });
    assert.deepEqual(result.errors, []);
    assert.match(result.notice, /No release tag/);
  });

  it("passes for unchanged migrations and allows new ones", () => {
    git("tag", "v0.1.0");
    write("db/migrations/0003_new.sql", "CREATE TABLE c (id INTEGER);\n");
    write("wrangler.jsonc", WRANGLER([V1, V2, { tag: "v3", new_sqlite_classes: ["C"] }]));
    const result = checkMigrations({ cwd: repo });
    assert.equal(result.ref, "v0.1.0");
    assert.deepEqual(result.errors, []);
  });

  it("fails for a changed or deleted D1 migration", () => {
    git("tag", "v0.1.0");
    write("db/migrations/0001_initial.sql", "CREATE TABLE a (id TEXT);\n");
    unlinkSync(join(repo, "db/migrations/0002_more.sql"));
    const { errors } = checkMigrations({ cwd: repo });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /0001_initial\.sql: changed since v0\.1\.0/);
    assert.match(errors[1], /0002_more\.sql: deleted/);
  });

  it("fails for a removed or reordered Durable Object migration", () => {
    git("tag", "v0.1.0");
    write("wrangler.jsonc", WRANGLER([V2, V1]));
    assert.match(checkMigrations({ cwd: repo }).errors[0], /"v1" moved/);
    write("wrangler.jsonc", WRANGLER([V1]));
    assert.match(checkMigrations({ cwd: repo }).errors[0], /"v2" was removed/);
  });

  it("compares with the highest release tag", () => {
    git("tag", "v0.9.0");
    git("tag", "v0.10.0");
    git("tag", "vnext");
    assert.equal(latestReleaseTag(repo), "v0.10.0");
  });
});
