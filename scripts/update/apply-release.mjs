#!/usr/bin/env node
// Applies an Envelopen release to a copy of the repository.
//
//   node scripts/update/apply-release.mjs --upstream <dir> --current <dir> [--base <dir>]
//     [--skip-workflows] [--dry-run] [--report <file>]
//
// --upstream  The files of the new release (for example `git archive v0.2.0`).
// --base      The files of the release that the copy is on now (the version in its
//             package.json). Without it, the script cannot see local changes or files
//             that the release deleted, and the report sets `baseMissing`.
// --current   The copy to change. The script changes it in place, unless --dry-run.
//
// The Deploy to Cloudflare button copies the repository without its history, so the
// update cannot use `git merge`. This script does a three-way file comparison instead.
// For each path, B is the base release, U is the new release, and C is the copy:
//
// 1. If C equals U, the path does not change.
// 2. If U equals B (the release did not change the path), C stays. Local changes and
//    files that the owner added stay.
// 3. If C equals B (the owner did not change the path), U replaces C. If the release
//    deleted the path, the script deletes it.
// 4. Otherwise both sides changed the path. U replaces C, and the path goes in
//    `conflicts`. The update workflow then opens a pull request, so the owner can see
//    the local changes that the update removes.
//
// wrangler.jsonc is never replaced. It gets a structured merge (mergeWrangler):
// - The release gives the structure, the comments, and the new bindings.
// - The copy keeps its own values for: the top-level `name`, `account_id`, `route`,
//   `routes`, `workers_dev`, and `preview_urls`; the resource fields of each binding
//   (`database_id`, `database_name`, `id`, `bucket_name`, queue names, Workflow names,
//   and similar); each var that the owner changed or added; and each binding that the
//   owner added.
// - Other keys follow rules 1 to 4, one key at a time.
// - Durable Object migrations come from the release. If the copy has migrations that
//   the release does not start with, the merge reports a conflict.
//
// --skip-workflows leaves .github/workflows/ unchanged, and lists the files that the
// release changes there in `skippedWorkflows`. A push with GITHUB_TOKEN cannot change
// workflow files.
//
// The script needs only Node.js 22.12 or later. It does not need `pnpm install`.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deepEqual, editJsonc, parseJsonc } from "./jsonc.mjs";

export const WRANGLER_FILE = "wrangler.jsonc";
export const WORKFLOW_DIR = ".github/workflows/";
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

// ---------------------------------------------------------------------------
// File trees

/** Lists the files under `root` as paths with `/`, without .git and node_modules. */
export function walkFiles(root) {
  const out = [];
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        out.push(`${prefix}${entry.name}`);
      }
    }
  }
  walk(root, "");
  return out.sort();
}

/**
 * Lists the files of the copy. In a git work tree, this is the tracked files plus the
 * untracked files that .gitignore does not ignore, so build output and local state
 * (dist, .wrangler, .dev.vars) never count as files of the copy.
 */
export function listCurrentFiles(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (statSync(top).ino !== statSync(root).ino) return walkFiles(root);
    const raw = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return [...new Set(raw.split("\0").filter(Boolean))]
      .filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile())
      .sort();
  } catch {
    return walkFiles(root);
  }
}

function readTree(root, files) {
  const map = new Map();
  for (const path of files) map.set(path, readFileSync(join(root, path)));
  return map;
}

function same(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

// ---------------------------------------------------------------------------
// wrangler.jsonc

const USER_KEYS = ["name", "account_id", "route", "routes", "workers_dev", "preview_urls"];

// Binding lists: the key that names a binding, and the fields that belong to the copy.
const COLLECTIONS = [
  {
    path: ["d1_databases"],
    key: "binding",
    user: ["database_id", "database_name", "preview_database_id"],
  },
  { path: ["kv_namespaces"], key: "binding", user: ["id", "preview_id"] },
  {
    path: ["r2_buckets"],
    key: "binding",
    user: ["bucket_name", "preview_bucket_name", "jurisdiction"],
  },
  { path: ["queues", "producers"], key: "binding", user: ["queue"] },
  { path: ["workflows"], key: "binding", user: ["name"] },
  { path: ["durable_objects", "bindings"], key: "name", user: ["script_name"] },
  { path: ["vectorize"], key: "binding", user: ["index_name"] },
  { path: ["hyperdrive"], key: "binding", user: ["id"] },
  { path: ["analytics_engine_datasets"], key: "binding", user: ["dataset"] },
  { path: ["services"], key: "binding", user: ["service"] },
  {
    path: ["send_email"],
    key: "name",
    user: ["destination_address", "allowed_destination_addresses"],
  },
];
const NESTED_PARENTS = new Set(["queues", "durable_objects"]);
const SPECIAL_KEYS = new Set([
  ...USER_KEYS,
  "vars",
  "migrations",
  ...NESTED_PARENTS,
  ...COLLECTIONS.filter((c) => c.path.length === 1).map((c) => c.path[0]),
]);

const has = (obj, key) => obj !== undefined && obj !== null && Object.hasOwn(obj, key);

/**
 * Three-way merge of one value. Returns `{ value, conflict }`. `undefined` means that the
 * key is absent. Without a base, a key of the copy that the release does not have stays.
 */
function threeWay(u, b, c, baseMissing) {
  if (deepEqual(c, u)) return { value: u };
  if (baseMissing) return { value: u === undefined ? c : u };
  if (deepEqual(u, b)) return { value: c };
  if (deepEqual(c, b)) return { value: u };
  return { value: u, conflict: true };
}

function mergeFields(u, b, c, userFields, baseMissing, label, conflicts) {
  const out = {};
  const keys = new Set([...Object.keys(u), ...Object.keys(c)]);
  for (const f of keys) {
    let value;
    if (userFields.includes(f) && has(c, f)) {
      value = c[f];
    } else {
      const r = threeWay(u[f], b?.[f], c[f], baseMissing || b === undefined);
      if (r.conflict) conflicts.push(`${label}.${f}`);
      value = r.value;
    }
    if (value !== undefined) out[f] = value;
  }
  return out;
}

function mergeCollection(spec, U, B, C, baseMissing, conflicts) {
  const label = spec.path.join(".");
  const u = U ?? [];
  const b = B ?? [];
  const c = C ?? [];
  const find = (list, name) => list.find((item) => item?.[spec.key] === name);
  const out = u.map((item) => {
    const mine = find(c, item[spec.key]);
    if (!mine) return item;
    return mergeFields(
      item,
      find(b, item[spec.key]),
      mine,
      spec.user,
      baseMissing,
      `${label}[${item[spec.key]}]`,
      conflicts,
    );
  });
  for (const mine of c) {
    const name = mine?.[spec.key];
    if (find(u, name)) continue;
    // A binding that the release removed goes. A binding that the owner added stays.
    if (!baseMissing && find(b, name)) continue;
    out.push(mine);
  }
  return out;
}

function mergeConsumers(U, B, C, renames, baseMissing, conflicts) {
  const c = C ?? [];
  const b = B ?? [];
  const used = new Set();
  const out = (U ?? []).map((uc) => {
    const target = renames.get(uc.queue) ?? uc.queue;
    const index = c.findIndex(
      (cc, n) => !used.has(n) && (cc.queue === target || cc.queue === uc.queue),
    );
    if (index === -1) {
      const item = { ...uc, queue: target };
      if (uc.dead_letter_queue && renames.has(uc.dead_letter_queue)) {
        item.dead_letter_queue = renames.get(uc.dead_letter_queue);
      }
      return item;
    }
    used.add(index);
    return mergeFields(
      uc,
      b.find((bc) => bc.queue === uc.queue),
      c[index],
      ["queue", "dead_letter_queue"],
      baseMissing,
      `queues.consumers[${uc.queue}]`,
      conflicts,
    );
  });
  c.forEach((cc, n) => {
    if (used.has(n)) return;
    if (!baseMissing && b.some((bc) => bc.queue === cc.queue)) return;
    out.push(cc);
  });
  return out;
}

function mergeVars(U, B, C) {
  const out = {};
  const keys = new Set([...Object.keys(U ?? {}), ...Object.keys(C ?? {})]);
  for (const k of keys) {
    const u = U?.[k];
    const b = B?.[k];
    const c = C?.[k];
    let value;
    if (c !== undefined && !deepEqual(c, b))
      value = c; // changed or added by the owner
    else if (c === undefined && b !== undefined && deepEqual(u, b)) value = undefined;
    else value = u;
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function isPrefix(short, long) {
  return short.length <= long.length && short.every((m, n) => deepEqual(m, long[n]));
}

/** Merges the parsed values of wrangler.jsonc. Returns `{ value, conflicts }`. */
export function mergeWranglerValues(U, B, C) {
  const baseMissing = B === undefined;
  const base = B ?? {};
  const conflicts = [];
  const out = structuredClone(U);

  for (const k of USER_KEYS) {
    if (has(C, k)) out[k] = C[k];
    else if (!baseMissing && has(base, k)) delete out[k];
  }

  for (const k of new Set([...Object.keys(U), ...Object.keys(C)])) {
    if (SPECIAL_KEYS.has(k)) continue;
    const r = threeWay(U[k], base[k], C[k], baseMissing);
    if (r.conflict) conflicts.push(k);
    if (r.value === undefined) delete out[k];
    else out[k] = r.value;
  }

  if (has(U, "vars") || has(C, "vars")) out.vars = mergeVars(U.vars, base.vars, C.vars);

  // Queue names that the copy renamed, from the producers of the same binding.
  const renames = new Map();
  for (const up of U.queues?.producers ?? []) {
    const mine = (C.queues?.producers ?? []).find((p) => p.binding === up.binding);
    if (mine?.queue && mine.queue !== up.queue) renames.set(up.queue, mine.queue);
  }
  for (const uc of U.queues?.consumers ?? []) {
    const target = renames.get(uc.queue);
    const mine = (C.queues?.consumers ?? []).find((cc) => cc.queue === (target ?? uc.queue));
    if (uc.dead_letter_queue && mine?.dead_letter_queue) {
      renames.set(uc.dead_letter_queue, mine.dead_letter_queue);
    }
  }

  for (const parent of NESTED_PARENTS) {
    if (!has(U, parent) && !has(C, parent)) continue;
    const r = threeWay(U[parent], base[parent], C[parent], baseMissing);
    const merged = { ...(r.value ?? {}) };
    for (const spec of COLLECTIONS.filter((s) => s.path[0] === parent)) {
      const child = spec.path[1];
      if (!has(U[parent], child) && !has(C[parent], child)) continue;
      merged[child] = mergeCollection(
        spec,
        U[parent]?.[child],
        base[parent]?.[child],
        C[parent]?.[child],
        baseMissing,
        conflicts,
      );
    }
    if (parent === "queues" && (has(U.queues, "consumers") || has(C.queues, "consumers"))) {
      merged.consumers = mergeConsumers(
        U.queues?.consumers,
        base.queues?.consumers,
        C.queues?.consumers,
        renames,
        baseMissing,
        conflicts,
      );
    }
    out[parent] = merged;
  }

  for (const spec of COLLECTIONS.filter((s) => s.path.length === 1)) {
    const k = spec.path[0];
    if (!has(U, k) && !has(C, k)) continue;
    out[k] = mergeCollection(spec, U[k], base[k], C[k], baseMissing, conflicts);
  }

  // Durable Object migrations belong to the release. The copy may only have more.
  const um = U.migrations ?? [];
  const cm = C.migrations ?? [];
  if (isPrefix(cm, um)) {
    if (has(U, "migrations")) out.migrations = um;
  } else if (isPrefix(um, cm)) {
    out.migrations = cm;
  } else {
    out.migrations = um;
    conflicts.push("migrations");
  }

  return { value: out, conflicts: conflicts.map((c) => `${WRANGLER_FILE}: ${c}`) };
}

/**
 * Merges the text of wrangler.jsonc. The result is the text of the release, with the
 * values of the copy written in. Comments of the release stay. Returns
 * `{ text, conflicts }`, or `{ text: undefined, conflicts }` if the copy cannot be read.
 */
export function mergeWrangler({ upstreamText, baseText, currentText }) {
  if (currentText === undefined) return { text: upstreamText, conflicts: [] };
  const upstream = parseJsonc(upstreamText).value;
  let current;
  try {
    current = parseJsonc(currentText).value;
  } catch (error) {
    return {
      text: undefined,
      conflicts: [`${WRANGLER_FILE}: the file is not valid JSONC (${error.message})`],
    };
  }
  let base;
  if (baseText !== undefined) {
    try {
      base = parseJsonc(baseText).value;
    } catch {
      base = undefined;
    }
  }
  const { value, conflicts } = mergeWranglerValues(upstream, base, current);
  // Same settings as the copy: keep the text of the copy as it is.
  if (deepEqual(value, current)) return { text: currentText, conflicts };
  return { text: editJsonc(upstreamText, value), conflicts };
}

// ---------------------------------------------------------------------------
// The plan

/**
 * Compares the three trees and returns the plan:
 * `{ writes, deletes, conflicts, skippedWorkflows, kept, baseMissing }`.
 * `writes` holds `{ path, content, mode }`. `kept` lists the files that only the copy has.
 */
export function planUpdate({ upstreamDir, currentDir, baseDir, skipWorkflows = false }) {
  const baseMissing = !baseDir;
  const U = readTree(upstreamDir, walkFiles(upstreamDir));
  const B = baseMissing ? new Map() : readTree(baseDir, walkFiles(baseDir));
  const C = readTree(currentDir, listCurrentFiles(currentDir));
  const plan = {
    writes: [],
    deletes: [],
    conflicts: [],
    skippedWorkflows: [],
    kept: [],
    baseMissing,
  };
  const paths = [...new Set([...U.keys(), ...B.keys(), ...C.keys()])].sort();

  for (const path of paths) {
    const u = U.get(path);
    const b = B.get(path);
    const c = C.get(path);
    let target = c;
    let conflict;

    if (path === WRANGLER_FILE && u !== undefined) {
      const merged = mergeWrangler({
        upstreamText: u.toString("utf8"),
        baseText: b?.toString("utf8"),
        currentText: c?.toString("utf8"),
      });
      plan.conflicts.push(...merged.conflicts);
      if (merged.text !== undefined) target = Buffer.from(merged.text, "utf8");
    } else if (same(c, u)) {
      target = c;
    } else if (baseMissing) {
      target = u ?? c;
    } else if (same(u, b)) {
      target = c;
    } else if (same(c, b)) {
      target = u;
    } else {
      target = u;
      if (u === undefined) conflict = "deleted in the release, changed in this repository";
      else if (c === undefined) conflict = "changed in the release, deleted in this repository";
      else if (b === undefined) conflict = "added in the release and in this repository";
      else conflict = "changed in the release and in this repository";
    }

    if (c !== undefined && u === undefined && b === undefined) plan.kept.push(path);
    if (same(target, c)) continue;

    if (skipWorkflows && path.startsWith(WORKFLOW_DIR)) {
      plan.skippedWorkflows.push(path);
      continue;
    }
    if (conflict) plan.conflicts.push(`${path}: ${conflict}`);
    if (target === undefined) {
      plan.deletes.push(path);
    } else {
      const executable = u !== undefined && statSync(join(upstreamDir, path)).mode & 0o111;
      plan.writes.push({ path, content: target, mode: executable ? 0o755 : 0o644 });
    }
  }
  return plan;
}

/** Writes the plan into `currentDir`. */
export function applyPlan(currentDir, plan) {
  for (const path of plan.deletes) {
    rmSync(join(currentDir, path), { force: true });
    // Remove directories that the delete left empty.
    let dir = dirname(join(currentDir, path));
    while (dir.startsWith(currentDir) && dir !== currentDir) {
      if (readdirSync(dir).length > 0) break;
      rmSync(dir, { recursive: true });
      dir = dirname(dir);
    }
  }
  for (const { path, content, mode } of plan.writes) {
    const file = join(currentDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
}

/** The plan as JSON, without file contents. */
export function reportOf(plan) {
  return {
    baseMissing: plan.baseMissing,
    written: plan.writes.map((w) => w.path),
    deleted: plan.deletes,
    conflicts: plan.conflicts,
    skippedWorkflows: plan.skippedWorkflows,
    kept: plan.kept,
  };
}

// ---------------------------------------------------------------------------
// CLI

function main() {
  const { values } = parseArgs({
    options: {
      upstream: { type: "string" },
      current: { type: "string" },
      base: { type: "string" },
      "skip-workflows": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      report: { type: "string" },
    },
  });
  if (!values.upstream || !values.current) {
    console.error(
      "Usage: apply-release.mjs --upstream <dir> --current <dir> [--base <dir>] " +
        "[--skip-workflows] [--dry-run] [--report <file>]",
    );
    process.exit(2);
  }
  const plan = planUpdate({
    upstreamDir: values.upstream,
    currentDir: values.current,
    baseDir: values.base,
    skipWorkflows: values["skip-workflows"],
  });
  if (!values["dry-run"]) applyPlan(values.current, plan);
  const report = reportOf(plan);
  if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);

  const list = (title, items) => {
    console.log(`${title}: ${items.length}`);
    for (const item of items) console.log(`  ${item}`);
  };
  list(values["dry-run"] ? "Files to write" : "Files written", report.written);
  list(values["dry-run"] ? "Files to delete" : "Files deleted", report.deleted);
  list("Conflicts", report.conflicts);
  list("Workflow files not changed", report.skippedWorkflows);
  console.log(`Files that only this repository has: ${report.kept.length}`);
  if (report.baseMissing) {
    console.log("No base release: local changes and deleted files cannot be detected.");
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
