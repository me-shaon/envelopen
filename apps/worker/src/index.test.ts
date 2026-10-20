import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import rootPackage from "../../../package.json";

const BASE = "https://envelopen.test";

describe("worker shell", () => {
  it("returns ok from /api/health", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: rootPackage.version });
  });

  it("routes /u/<token> to the Worker, not the SPA", async () => {
    // An unknown token gets the generic page from the Worker.
    const res = await exports.default.fetch(`${BASE}/u/abc123`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("This link is not valid");
  });

  // The test runner calls the Worker directly and skips the asset router, so this
  // checks the SPA fallback through the ASSETS binding. It needs the web build.
  it("serves the SPA index.html for an unknown client route", async () => {
    const res = await env.ASSETS.fetch(`${BASE}/campaigns`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});
