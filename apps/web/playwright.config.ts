import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the admin app against `wrangler dev` with a local D1.
// Five Workers run: one in password mode, one in passkey mode (PBKDF2 below 100000),
// one for the contacts spec, one for the providers spec, and one for the editor spec,
// so their owners and data start fresh. The providers and editor Workers send their
// provider and DNS requests to local mock servers (e2e/provider-mock.mjs), one each,
// so each spec sees only its own sent emails.
// The secrets are random per run unless E2E_* variables set them. Playwright loads this
// file before it starts the workers, so they inherit the same values.

process.env.E2E_SETUP_TOKEN ??= randomBytes(32).toString("hex");
process.env.E2E_SIGNING_KEY ??= randomBytes(32).toString("base64");
process.env.E2E_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

export const PASSWORD_PORT = 8790;
export const PASSKEY_PORT = 8791;
export const CONTACTS_PORT = 8792;
export const PROVIDERS_PORT = 8793;
export const EDITOR_PORT = 8794;
export const PROVIDER_MOCK_PORT = 8799;
export const EDITOR_MOCK_PORT = 8798;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PASSWORD_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node e2e/serve.mjs ${PASSWORD_PORT} password 100000`,
      url: `http://localhost:${PASSWORD_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${PASSKEY_PORT} passkey 50000`,
      url: `http://localhost:${PASSKEY_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${CONTACTS_PORT} contacts 100000`,
      url: `http://localhost:${CONTACTS_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/provider-mock.mjs ${PROVIDER_MOCK_PORT}`,
      url: `http://127.0.0.1:${PROVIDER_MOCK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${PROVIDERS_PORT} providers 100000 http://127.0.0.1:${PROVIDER_MOCK_PORT}`,
      url: `http://localhost:${PROVIDERS_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/provider-mock.mjs ${EDITOR_MOCK_PORT}`,
      url: `http://127.0.0.1:${EDITOR_MOCK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${EDITOR_PORT} editor 100000 http://127.0.0.1:${EDITOR_MOCK_PORT}`,
      url: `http://localhost:${EDITOR_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
