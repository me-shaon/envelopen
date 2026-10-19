import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The adapters run in workerd, as in production, so WebCrypto behaves the same.
// Provider HTTP is a fetch mock in every test: no test calls a real provider.
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-10-01" } })],
});
