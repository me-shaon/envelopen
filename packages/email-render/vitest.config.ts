import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects. The Worker-side code (sanitizer, tokens, personalization) runs in
// workerd, as in production: HTMLRewriter exists only there. The React Email renderer
// runs in Node, as it does in a browser-like JS engine, because it never runs in the
// Worker (KTD26).
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-10-01" } })],
        test: {
          name: "workers",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.node.test.ts"],
        },
      },
      {
        test: { name: "node", environment: "node", include: ["src/**/*.node.test.ts"] },
      },
    ],
  },
});
