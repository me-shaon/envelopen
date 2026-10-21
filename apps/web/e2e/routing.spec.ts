import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PASSWORD_PORT } from "../playwright.config";

// The asset router of `wrangler dev`, as configured in wrangler.jsonc: the paths in
// `run_worker_first` reach the Worker, and every other unknown path gets the SPA
// index.html. The Vitest pool calls the Worker directly and skips this router, so only
// a real `wrangler dev` can show it.

const BASE = `http://localhost:${PASSWORD_PORT}`;
const VERSION: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
const SPA_MARKER = '<div id="root"></div>';
// The headers of a browser navigation, so the SPA fallback applies where it can.
const NAVIGATION = { accept: "text/html", "sec-fetch-mode": "navigate" };

test.describe("asset routing", () => {
  test("sends /api/*, /mcp, /t/*, /u/*, /f/*, and /hooks/* to the Worker", async ({ request }) => {
    const health = await request.get(`${BASE}/api/health`, { headers: NAVIGATION });
    expect(await health.json()).toEqual({ status: "ok", version: VERSION });

    const paths = [
      "/api/unknown-route",
      "/mcp",
      "/t/o/not-a-token.gif",
      "/u/not-a-token",
      "/f/not-a-form",
      "/hooks/resend/0/0",
    ];
    for (const path of paths) {
      const response = await request.get(`${BASE}${path}`, {
        headers: NAVIGATION,
        maxRedirects: 0,
      });
      expect(await response.text(), path).not.toContain(SPA_MARKER);
    }

    // The Worker's own answers, which the asset router cannot give.
    const unsubscribe = await request.get(`${BASE}/u/not-a-token`, { headers: NAVIGATION });
    expect(unsubscribe.status()).toBe(404);
    expect(await unsubscribe.text()).toContain("This link is not valid");
    const api = await request.get(`${BASE}/api/unknown-route`, { headers: NAVIGATION });
    expect(api.headers()["content-type"]).toContain("application/json");
  });

  test("serves the SPA index for an unknown path outside the Worker routes", async ({
    request,
  }) => {
    for (const path of ["/campaigns/123", "/no/such/page", "/apihealth", "/unsubscribe"]) {
      const response = await request.get(`${BASE}${path}`, { headers: NAVIGATION });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"], path).toContain("text/html");
      expect(await response.text(), path).toContain(SPA_MARKER);
    }
  });
});
