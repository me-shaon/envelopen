#!/usr/bin/env node
// Fails if a shipped migration changed.
//
//   node scripts/check-migrations.mjs [--ref <tag>] [--github]
//
// --github prints the results as GitHub Actions annotations.
//
// Deployments apply each D1 migration once and record its file name. A changed or
// deleted migration that a release already shipped never runs again on those
// deployments, so their schema drifts from the code. This check compares the working
// tree with the latest release tag (the highest `v*` tag, or --ref):
//
// - Each file in a D1 `migrations_dir` of the tag must exist with the same content.
//   New files are allowed.
// - The Durable Object `migrations` list in wrangler.jsonc of the tag must be the start
//   of the current list. New entries at the end are allowed. Removed, reordered, or
//   changed entries fail.
//
// Without a `v*` tag, the check prints a notice and passes. CI needs the tags, so the
// checkout must fetch the full history (`fetch-depth: 0`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deepEqual, parseJsonc } from "./update/jsonc.mjs";
import { compareVersions, parseVersion } from "./update/version.mjs";

function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] });
}

/** Returns the highest `v*` tag that is a semantic version, or undefined. */
export function latestReleaseTag(cwd) {
  const tags = git(cwd, ["tag", "--list", "v*"])
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => {
      try {
        parseVersion(t);
        return true;
      } catch {
        return false;
      }
    });
  return tags.sort(compareVersions).at(-1);
}

function readWrangler(text) {
  return text === undefined ? {} : parseJsonc(text).value;
}

function migrationDirs(config) {
  return (config.d1_databases ?? []).map((db) => db.migrations_dir ?? "migrations");
}

/** Returns `{ ref, errors, notice }`. */
export function checkMigrations({ cwd = process.cwd(), ref } = {}) {
  const tag = ref ?? latestReleaseTag(cwd);
  if (!tag) {
    return { ref: undefined, errors: [], notice: "No release tag (v*) yet. Skipped the check." };
  }
  const errors = [];
  let tagWranglerText;
  try {
    tagWranglerText = git(cwd, ["show", `${tag}:wrangler.jsonc`]);
  } catch {
    tagWranglerText = undefined;
  }
  const currentPath = join(cwd, "wrangler.jsonc");
  const currentText = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : undefined;
  const tagConfig = readWrangler(tagWranglerText);
  const currentConfig = readWrangler(currentText);

  const dirs = new Set([...migrationDirs(tagConfig), ...migrationDirs(currentConfig)]);
  for (const dir of dirs) {
    const shipped = git(cwd, ["ls-tree", "-r", "--name-only", tag, "--", dir])
      .split("\n")
      .filter(Boolean);
    for (const path of shipped) {
      const file = join(cwd, path);
      if (!existsSync(file)) {
        errors.push(`${path}: deleted, but ${tag} shipped it. Restore the file.`);
        continue;
      }
      const before = git(cwd, ["show", `${tag}:${path}`], "buffer");
      if (!before.equals(readFileSync(file))) {
        errors.push(
          `${path}: changed since ${tag}. Restore it, and put the change in a new migration.`,
        );
      }
    }
  }

  const before = tagConfig.migrations ?? [];
  const after = currentConfig.migrations ?? [];
  before.forEach((entry, n) => {
    if (deepEqual(entry, after[n])) return;
    const moved = after.findIndex((m) => m?.tag === entry.tag);
    if (moved === -1) {
      errors.push(`wrangler.jsonc: the Durable Object migration "${entry.tag}" was removed.`);
    } else if (moved !== n) {
      errors.push(`wrangler.jsonc: the Durable Object migration "${entry.tag}" moved.`);
    } else {
      errors.push(`wrangler.jsonc: the Durable Object migration "${entry.tag}" changed.`);
    }
  });

  return { ref: tag, errors, notice: undefined };
}

function main() {
  const { values } = parseArgs({
    options: { ref: { type: "string" }, github: { type: "boolean", default: false } },
  });
  const result = checkMigrations({ ref: values.ref });
  const actions = values.github;
  if (result.notice) {
    console.log(actions ? `::notice::${result.notice}` : result.notice);
    return;
  }
  if (result.errors.length === 0) {
    console.log(`Shipped migrations match ${result.ref}.`);
    return;
  }
  for (const error of result.errors) console.log(actions ? `::error::${error}` : error);
  process.exit(1);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
