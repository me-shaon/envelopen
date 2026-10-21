import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the admin app against `wrangler dev` with a local D1.
// Nine Workers run: one in password mode, one in passkey mode (PBKDF2 below 100000),
// one each for the contacts, providers, editor, campaigns, and first-campaign specs,
// so their owners and data start fresh, and two for the backup spec: the source and
// the restore target, which has its own keys. The providers, editor, campaigns, and
// first-campaign Workers send their provider and DNS requests to local mock servers
// (e2e/provider-mock.mjs), one each, so each spec sees only its own sent emails.
// The secrets are random per run unless E2E_* variables set them. Playwright loads this
// file before it starts the workers, so they inherit the same values.

process.env.E2E_SETUP_TOKEN ??= randomBytes(32).toString("hex");
process.env.E2E_SIGNING_KEY ??= randomBytes(32).toString("base64");
process.env.E2E_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
// The restore target of the backup spec is a new deployment with its own keys.
process.env.E2E_SIGNING_KEY_BACKUP_TARGET ??= randomBytes(32).toString("base64");
process.env.E2E_ENCRYPTION_KEY_BACKUP_TARGET ??= randomBytes(32).toString("base64");

export const PASSWORD_PORT = 8790;
export const PASSKEY_PORT = 8791;
export const CONTACTS_PORT = 8792;
export const PROVIDERS_PORT = 8793;
export const EDITOR_PORT = 8794;
export const CAMPAIGNS_PORT = 8795;
export const FIRST_CAMPAIGN_PORT = 8796;
export const CAMPAIGNS_MOCK_PORT = 8797;
export const PROVIDER_MOCK_PORT = 8799;
export const EDITOR_MOCK_PORT = 8798;
export const FIRST_CAMPAIGN_MOCK_PORT = 8800;
export const BACKUP_SOURCE_PORT = 8801;
export const BACKUP_TARGET_PORT = 8802;
export const BACKUP_MOCK_PORT = 8803;

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
    // Most specs run with reduced motion, so the app settles at once and the steps do
    // not wait for fades. The motion test in contacts.spec.ts turns motion back on.
    reducedMotion: "reduce",
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
    {
      // The campaigns mock also serves the DMARC record, so the sending domain verifies.
      command: `node e2e/provider-mock.mjs ${CAMPAIGNS_MOCK_PORT} --dmarc`,
      url: `http://127.0.0.1:${CAMPAIGNS_MOCK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${CAMPAIGNS_PORT} campaigns 100000 http://127.0.0.1:${CAMPAIGNS_MOCK_PORT}`,
      url: `http://localhost:${CAMPAIGNS_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/provider-mock.mjs ${FIRST_CAMPAIGN_MOCK_PORT} --dmarc`,
      url: `http://127.0.0.1:${FIRST_CAMPAIGN_MOCK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${FIRST_CAMPAIGN_PORT} first-campaign 100000 http://127.0.0.1:${FIRST_CAMPAIGN_MOCK_PORT}`,
      url: `http://localhost:${FIRST_CAMPAIGN_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The backup source sends its S3 copy to a mock that has no S3, so the copy fails.
      command: `node e2e/provider-mock.mjs ${BACKUP_MOCK_PORT}`,
      url: `http://127.0.0.1:${BACKUP_MOCK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${BACKUP_SOURCE_PORT} backup-source 100000 http://127.0.0.1:${BACKUP_MOCK_PORT}`,
      url: `http://localhost:${BACKUP_SOURCE_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs ${BACKUP_TARGET_PORT} backup-target 100000`,
      url: `http://localhost:${BACKUP_TARGET_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
