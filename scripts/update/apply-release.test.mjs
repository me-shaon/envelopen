import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { applyPlan, mergeWrangler, planUpdate, reportOf } from "./apply-release.mjs";
import { parseJsonc } from "./jsonc.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "envelopen-apply-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run({ base, upstream, current, skipWorkflows }) {
  const baseDir = base ? tree(base) : undefined;
  const upstreamDir = tree(upstream);
  const currentDir = tree(current);
  const plan = planUpdate({ upstreamDir, currentDir, baseDir, skipWorkflows });
  applyPlan(currentDir, plan);
  const read = (path) =>
    existsSync(join(currentDir, path)) ? readFileSync(join(currentDir, path), "utf8") : undefined;
  return { report: reportOf(plan), read, currentDir };
}

describe("apply-release: files", () => {
  it("replaces files that the release changed", () => {
    const { report, read } = run({
      base: { "a.txt": "1", "b.txt": "same" },
      upstream: { "a.txt": "2", "b.txt": "same", "new/c.txt": "3" },
      current: { "a.txt": "1", "b.txt": "same" },
    });
    assert.equal(read("a.txt"), "2");
    assert.equal(read("new/c.txt"), "3");
    assert.deepEqual(report.written, ["a.txt", "new/c.txt"]);
    assert.deepEqual(report.conflicts, []);
  });

  it("deletes files that the release deleted, and empty directories", () => {
    const { report, read, currentDir } = run({
      base: { "a.txt": "1", "old/gone.txt": "x" },
      upstream: { "a.txt": "1" },
      current: { "a.txt": "1", "old/gone.txt": "x" },
    });
    assert.equal(read("old/gone.txt"), undefined);
    assert.equal(existsSync(join(currentDir, "old")), false);
    assert.deepEqual(report.deleted, ["old/gone.txt"]);
  });

  it("keeps files that the owner added", () => {
    const { report, read } = run({
      base: { "a.txt": "1" },
      upstream: { "a.txt": "2" },
      current: { "a.txt": "1", "notes/mine.md": "mine", "apps/web/extra.ts": "x" },
    });
    assert.equal(read("notes/mine.md"), "mine");
    assert.equal(read("apps/web/extra.ts"), "x");
    assert.deepEqual(report.kept, ["apps/web/extra.ts", "notes/mine.md"]);
  });

  it("keeps a local change to a file that the release did not change", () => {
    const { report, read } = run({
      base: { "README.md": "upstream" },
      upstream: { "README.md": "upstream", "x.txt": "new" },
      current: { "README.md": "my readme" },
    });
    assert.equal(read("README.md"), "my readme");
    assert.deepEqual(report.conflicts, []);
  });

  it("reports files that both the owner and the release changed", () => {
    const { report, read } = run({
      base: { "a.txt": "1", "b.txt": "1", "c.txt": "1" },
      upstream: { "a.txt": "2", "c.txt": "2" },
      current: { "a.txt": "mine", "b.txt": "mine" },
    });
    assert.equal(read("a.txt"), "2");
    assert.equal(read("b.txt"), undefined);
    assert.equal(read("c.txt"), "2");
    assert.deepEqual(report.conflicts, [
      "a.txt: changed in the release and in this repository",
      "b.txt: deleted in the release, changed in this repository",
      "c.txt: changed in the release, deleted in this repository",
    ]);
  });

  it("leaves workflow files alone with --skip-workflows, and lists them", () => {
    const files = {
      base: { ".github/workflows/ci.yml": "v1", "a.txt": "1" },
      upstream: {
        ".github/workflows/ci.yml": "v2",
        ".github/workflows/new.yml": "n",
        "a.txt": "2",
      },
      current: { ".github/workflows/ci.yml": "v1", "a.txt": "1" },
    };
    const skipped = run({ ...files, skipWorkflows: true });
    assert.equal(skipped.read(".github/workflows/ci.yml"), "v1");
    assert.equal(skipped.read(".github/workflows/new.yml"), undefined);
    assert.equal(skipped.read("a.txt"), "2");
    assert.deepEqual(skipped.report.skippedWorkflows, [
      ".github/workflows/ci.yml",
      ".github/workflows/new.yml",
    ]);

    const applied = run(files);
    assert.equal(applied.read(".github/workflows/ci.yml"), "v2");
    assert.deepEqual(applied.report.skippedWorkflows, []);
  });

  it("without a base, writes the release and deletes nothing", () => {
    const { report, read } = run({
      upstream: { "a.txt": "2" },
      current: { "a.txt": "1", "old.txt": "x" },
    });
    assert.equal(report.baseMissing, true);
    assert.equal(read("a.txt"), "2");
    assert.equal(read("old.txt"), "x");
  });

  it("ignores build output that .gitignore excludes in a git copy", () => {
    const currentDir = tree({ ".gitignore": "dist/\n", "a.txt": "1", "dist/out.js": "x" });
    execFileSync("git", ["init", "-q"], { cwd: currentDir });
    const plan = planUpdate({
      upstreamDir: tree({ ".gitignore": "dist/\n", "a.txt": "2" }),
      baseDir: tree({ ".gitignore": "dist/\n", "a.txt": "1" }),
      currentDir,
    });
    assert.deepEqual(reportOf(plan).kept, []);
    assert.deepEqual(reportOf(plan).written, ["a.txt"]);
  });
});

const BASE_WRANGLER = `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "envelopen",
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "2026-10-01",
  // Resource IDs are omitted.
  "d1_databases": [
    { "binding": "DB", "database_name": "envelopen", "migrations_dir": "packages/db/migrations" }
  ],
  "kv_namespaces": [{ "binding": "KV" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "envelopen-files" }],
  "queues": {
    "producers": [{ "binding": "SEND_QUEUE", "queue": "send-queue" }],
    "consumers": [
      { "queue": "send-queue", "max_batch_size": 1, "dead_letter_queue": "send-queue-dlq" }
    ]
  },
  "vars": {
    // Password hash cost.
    "PBKDF2_ITERATIONS": "100000",
    "LOG_LEVEL": "info"
  },
  "durable_objects": {
    "bindings": [{ "name": "USAGE_METER", "class_name": "UsageMeter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UsageMeter"] }],
}
`;

const UPSTREAM_WRANGLER = BASE_WRANGLER.replace(
  '"compatibility_date": "2026-10-01"',
  '"compatibility_date": "2026-11-01"',
)
  .replace(
    '"kv_namespaces": [{ "binding": "KV" }],',
    `"kv_namespaces": [{ "binding": "KV" }],
  // The new cache for rendered emails.
  "r2_buckets_note": "release 0.2.0",`,
  )
  .replace(
    '"LOG_LEVEL": "info"',
    `"LOG_LEVEL": "warn",
    "NEW_VAR": "on"`,
  )
  .replace(
    '"bindings": [{ "name": "USAGE_METER", "class_name": "UsageMeter" }]',
    `"bindings": [
      { "name": "USAGE_METER", "class_name": "UsageMeter" },
      // Counts sends per day.
      { "name": "SEND_COUNTER", "class_name": "SendCounter" }
    ]`,
  )
  .replace(
    '"migrations": [{ "tag": "v1", "new_sqlite_classes": ["UsageMeter"] }],',
    `"migrations": [
    { "tag": "v1", "new_sqlite_classes": ["UsageMeter"] },
    { "tag": "v2", "new_sqlite_classes": ["SendCounter"] }
  ],`,
  );

// What the Deploy button and the owner did to the copy.
const CURRENT_WRANGLER = JSON.stringify(
  {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "acme-mail",
    main: "apps/worker/src/index.ts",
    compatibility_date: "2026-10-01",
    routes: [{ pattern: "mail.acme.test", custom_domain: true }],
    d1_databases: [
      {
        binding: "DB",
        database_name: "acme-mail-db",
        database_id: "1111-2222",
        migrations_dir: "packages/db/migrations",
      },
    ],
    kv_namespaces: [
      { binding: "KV", id: "kv-123" },
      { binding: "MY_CACHE", id: "kv-mine" },
    ],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "acme-files" }],
    queues: {
      producers: [{ binding: "SEND_QUEUE", queue: "acme-send" }],
      consumers: [{ queue: "acme-send", max_batch_size: 1, dead_letter_queue: "acme-dlq" }],
    },
    vars: { PBKDF2_ITERATIONS: "60000", LOG_LEVEL: "info", MY_VAR: "x" },
    durable_objects: { bindings: [{ name: "USAGE_METER", class_name: "UsageMeter" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["UsageMeter"] }],
  },
  null,
  2,
);

describe("apply-release: wrangler.jsonc", () => {
  it("takes the release structure and keeps the values of the copy", () => {
    const { text, conflicts } = mergeWrangler({
      upstreamText: UPSTREAM_WRANGLER,
      baseText: BASE_WRANGLER,
      currentText: CURRENT_WRANGLER,
    });
    assert.deepEqual(conflicts, []);
    const merged = parseJsonc(text).value;

    assert.equal(merged.name, "acme-mail");
    assert.deepEqual(merged.routes, [{ pattern: "mail.acme.test", custom_domain: true }]);
    assert.equal(merged.compatibility_date, "2026-11-01");
    assert.equal(merged.r2_buckets_note, "release 0.2.0");
    assert.deepEqual(merged.d1_databases, [
      {
        binding: "DB",
        database_name: "acme-mail-db",
        migrations_dir: "packages/db/migrations",
        database_id: "1111-2222",
      },
    ]);
    assert.deepEqual(merged.kv_namespaces, [
      { binding: "KV", id: "kv-123" },
      { binding: "MY_CACHE", id: "kv-mine" },
    ]);
    assert.deepEqual(merged.r2_buckets, [{ binding: "BUCKET", bucket_name: "acme-files" }]);
    assert.deepEqual(merged.queues, {
      producers: [{ binding: "SEND_QUEUE", queue: "acme-send" }],
      consumers: [{ queue: "acme-send", max_batch_size: 1, dead_letter_queue: "acme-dlq" }],
    });
    // Changed by the owner: kept. Not changed: the release value. Added: kept.
    assert.deepEqual(merged.vars, {
      PBKDF2_ITERATIONS: "60000",
      LOG_LEVEL: "warn",
      NEW_VAR: "on",
      MY_VAR: "x",
    });
    assert.deepEqual(
      merged.durable_objects.bindings.map((b) => b.name),
      ["USAGE_METER", "SEND_COUNTER"],
    );
    assert.deepEqual(
      merged.migrations.map((m) => m.tag),
      ["v1", "v2"],
    );
    // The comments of the release stay.
    assert.match(text, /\/\/ Counts sends per day\./);
    assert.match(text, /\/\/ The new cache for rendered emails\./);
    assert.match(text, /\/\/ Password hash cost\./);
  });

  it("drops a binding that the release removed, and keeps one the owner added", () => {
    const upstream = BASE_WRANGLER.replace(
      '"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "envelopen-files" }],',
      "",
    );
    const current = BASE_WRANGLER.replace(
      '{ "binding": "BUCKET", "bucket_name": "envelopen-files" }',
      '{ "binding": "BUCKET", "bucket_name": "envelopen-files" }, { "binding": "MINE", "bucket_name": "m" }',
    );
    const merged = parseJsonc(
      mergeWrangler({ upstreamText: upstream, baseText: BASE_WRANGLER, currentText: current }).text,
    ).value;
    assert.deepEqual(merged.r2_buckets, [{ binding: "MINE", bucket_name: "m" }]);
  });

  it("reports Durable Object migrations that the release does not start with", () => {
    const current = BASE_WRANGLER.replace(
      '"migrations": [{ "tag": "v1", "new_sqlite_classes": ["UsageMeter"] }],',
      '"migrations": [{ "tag": "v1", "new_sqlite_classes": ["UsageMeter"] }, { "tag": "mine", "new_sqlite_classes": ["Mine"] }],',
    );
    const { conflicts, text } = mergeWrangler({
      upstreamText: UPSTREAM_WRANGLER,
      baseText: BASE_WRANGLER,
      currentText: current,
    });
    assert.deepEqual(conflicts, ["wrangler.jsonc: migrations"]);
    assert.deepEqual(
      parseJsonc(text).value.migrations.map((m) => m.tag),
      ["v1", "v2"],
    );
  });

  it("keeps a copy that is not valid JSONC, and reports it", () => {
    const { text, conflicts } = mergeWrangler({
      upstreamText: UPSTREAM_WRANGLER,
      baseText: BASE_WRANGLER,
      currentText: "{ broken",
    });
    assert.equal(text, undefined);
    assert.match(conflicts[0], /not valid JSONC/);
  });

  it("never reports wrangler.jsonc as a file conflict", () => {
    const { report, read } = run({
      base: { "wrangler.jsonc": BASE_WRANGLER },
      upstream: { "wrangler.jsonc": UPSTREAM_WRANGLER },
      current: { "wrangler.jsonc": CURRENT_WRANGLER },
    });
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.written, ["wrangler.jsonc"]);
    assert.equal(parseJsonc(read("wrangler.jsonc")).value.name, "acme-mail");
  });
});
