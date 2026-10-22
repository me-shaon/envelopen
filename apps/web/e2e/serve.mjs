// Starts a fresh local Worker for the end-to-end tests: a new D1 state directory, the
// migrations, and `wrangler dev` with the test secrets from the environment.
//
//   node e2e/serve.mjs <port> <state-name> <pbkdf2-iterations> [outbound-mock-origin] [smtp-mock]
//
// With an outbound mock origin, the Worker sends provider and DNS requests to that
// local server (OUTBOUND_MOCK_ORIGIN), so no test reaches a real provider. With an SMTP
// mock (`127.0.0.1:<port>`, e2e/smtp-mock.mjs), SMTP connections go there
// (OUTBOUND_MOCK_SMTP), so no test reaches a real mail server.
// Playwright runs it (playwright.config.ts). The web app must be built first, because
// the Worker serves apps/web/dist.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [port, stateName, iterations, mockOrigin, smtpMock] = process.argv.slice(2);
if (!port || !stateName || !iterations) {
  console.error("Usage: node e2e/serve.mjs <port> <state-name> <pbkdf2-iterations>");
  process.exit(1);
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const state = `.wrangler/e2e/${stateName}`;
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
// Run wrangler with this Node, so the tests do not depend on how pnpm was installed.
const wrangler = [
  fileURLToPath(new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
];

// A Worker can have its own secret: E2E_<NAME>_<STATE> wins over E2E_<NAME>. The
// backup spec restores into a Worker with other keys, as a new deployment has.
const stateKey = stateName.toUpperCase().replaceAll("-", "_");
const secrets = ["SETUP_TOKEN", "SIGNING_KEY", "ENCRYPTION_KEY"].map((name) => {
  const value = process.env[`E2E_${name}_${stateKey}`] ?? process.env[`E2E_${name}`];
  if (!value) {
    console.error(`E2E_${name} is not set. Run the tests through Playwright.`);
    process.exit(1);
  }
  return `${name}:${value}`;
});

// Optional secrets: the forms spec sets Cloudflare's Turnstile test keys for its Worker.
for (const name of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET"]) {
  const value = process.env[`E2E_${name}_${stateKey}`];
  if (value) secrets.push(`${name}:${value}`);
}

rmSync(new URL(`../../../${state}`, import.meta.url), { recursive: true, force: true });

const migrate = spawnSync(
  process.execPath,
  [...wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
  { cwd: root, env, stdio: "inherit" },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  process.execPath,
  [
    ...wrangler,
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
    // Tracking events reach D1 a second after they arrive, not 30 seconds.
    "EVENT_FLUSH_DELAY_MS:1000",
    ...(mockOrigin ? [`OUTBOUND_MOCK_ORIGIN:${mockOrigin}`] : []),
    ...(smtpMock ? [`OUTBOUND_MOCK_SMTP:${smtpMock}`] : []),
  ],
  { cwd: root, env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => dev.kill(signal));
}
dev.on("exit", (code) => process.exit(code ?? 0));
