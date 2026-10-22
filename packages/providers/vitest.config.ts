import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The adapters run in workerd, as in production, so WebCrypto behaves the same.
// Provider HTTP is a fetch mock in every test: no test calls a real provider.
// SMTP_TRIAL (`127.0.0.1:<port>` of apps/web/e2e/smtp-mock.mjs) turns on the SMTP
// timing trial in src/smtp/trial.test.ts. It accepts only a localhost address.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        bindings: { SMTP_TRIAL: process.env.SMTP_TRIAL ?? "" },
      },
    }),
  ],
});
