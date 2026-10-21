import { defineConfig } from "vitest/config";

// Unit tests of the browser helpers that need no DOM, such as the timezone conversion.
// The end-to-end tests in e2e/ run with Playwright.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
