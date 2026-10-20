#!/usr/bin/env node
// Semantic version helpers for the update and release workflows. No dependencies.
//
//   node scripts/update/version.mjs compare <a> <b>   Prints "newer" if a > b, "same", or "older".
//   node scripts/update/version.mjs current [dir]     Prints the version in package.json.
//   node scripts/update/version.mjs notes <version> [CHANGELOG.md]
//                                                     Prints the CHANGELOG section of a version.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses "1.2.3", "v1.2.3", or "1.2.3-rc.1". Throws on anything else. */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim());
  if (!m) throw new Error(`Not a semantic version: ${text}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Returns 1 if a > b, 0 if they are equal, and -1 if a < b. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  // A version without a pre-release part is higher than one with it.
  if (x.pre.length === 0 || y.pre.length === 0) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  }
  for (let n = 0; n < Math.max(x.pre.length, y.pre.length); n++) {
    const p = x.pre[n];
    const q = y.pre[n];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/** Returns the body of the `## [version]` section of a Keep a Changelog file. */
export function changelogSection(changelog, version) {
  const wanted = String(version).replace(/^v/, "");
  const lines = changelog.split("\n");
  const heading = /^## \[?v?([^\]\s]+)\]?/;
  const start = lines.findIndex((l) => heading.exec(l)?.[1] === wanted);
  if (start === -1) return undefined;
  let end = lines.findIndex((l, n) => n > start && (heading.test(l) || /^\[[^\]]+\]:/.test(l)));
  if (end === -1) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "compare" && args.length === 2) {
    const r = compareVersions(args[0], args[1]);
    console.log(r > 0 ? "newer" : r === 0 ? "same" : "older");
  } else if (command === "current") {
    const pkg = JSON.parse(readFileSync(join(args[0] ?? ".", "package.json"), "utf8"));
    parseVersion(pkg.version);
    console.log(pkg.version);
  } else if (command === "notes" && args.length >= 1) {
    const section = changelogSection(readFileSync(args[1] ?? "CHANGELOG.md", "utf8"), args[0]);
    if (section === undefined) {
      console.error(`CHANGELOG.md has no section for ${args[0]}.`);
      process.exit(1);
    }
    console.log(section);
  } else {
    console.error(
      "Usage: version.mjs compare <a> <b> | current [dir] | notes <version> [CHANGELOG.md]",
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
