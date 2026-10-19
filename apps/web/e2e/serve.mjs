// Starts a fresh local Worker for the end-to-end tests: a new D1 state directory, the
// migrations, and `wrangler dev` with the test secrets from the environment.
//
//   node e2e/serve.mjs <port> <state-name> <pbkdf2-iterations> [outbound-mock-origin]
//
// With an outbound mock origin, the Worker sends provider and DNS requests to that
// local server (OUTBOUND_MOCK_ORIGIN), so no test reaches a real provider.
// Playwright runs it (playwright.config.ts). The web app must be built first, because
// the Worker serves apps/web/dist.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [port, stateName, iterations, mockOrigin] = process.argv.slice(2);
if (!port || !stateName || !iterations) {
  console.error("Usage: node e2e/serve.mjs <port> <state-name> <pbkdf2-iterations>");
  process.exit(1);
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const state = `.wrangler/e2e/${stateName}`;
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };

const secrets = ["SETUP_TOKEN", "SIGNING_KEY", "ENCRYPTION_KEY"].map((name) => {
  const value = process.env[`E2E_${name}`];
  if (!value) {
    console.error(`E2E_${name} is not set. Run the tests through Playwright.`);
    process.exit(1);
  }
  return `${name}:${value}`;
});

rmSync(new URL(`../../../${state}`, import.meta.url), { recursive: true, force: true });

const migrate = spawnSync(
  "corepack",
  ["pnpm", "exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
  { cwd: root, env, stdio: "inherit" },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  "corepack",
  [
    "pnpm",
    "exec",
    "wrangler",
    "dev",
    "--port",
    port,
    "--ip",
    "127.0.0.1",
    "--persist-to",
    state,
    "--show-interactive-dev-session=false",
    "--var",
    ...secrets,
    `PBKDF2_ITERATIONS:${iterations}`,
    ...(mockOrigin ? [`OUTBOUND_MOCK_ORIGIN:${mockOrigin}`] : []),
  ],
  { cwd: root, env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => dev.kill(signal));
}
dev.on("exit", (code) => process.exit(code ?? 0));
