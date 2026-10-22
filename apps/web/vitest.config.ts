import { defineConfig } from "vitest/config";

// Unit tests of the browser helpers that need no DOM, such as the timezone conversion
// and the editor schema (U14). The end-to-end tests in e2e/ run with Playwright.
export default defineConfig({
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
