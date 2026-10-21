import { env } from "cloudflare:workers";
import {
  DEFAULT_SOURCE_URL,
  runOperation,
  SOURCE_URL_SETTING,
  settingsUpdate,
} from "@envelopen/core";
import { afterEach, describe, expect, it } from "vitest";
import { call, mount, recordingDeps, sentCampaign } from "../../test/tracking-helpers";
import { settingsCache } from "../services";
import { ENVELOPEN_VERSION } from "../version";
import { createTrackingRoutes, createUnsubscribeRoutes } from "./index";
import { renderPage } from "./preferences";

// The source link in the footer of every public page (KTD16, R6, AGPL section 13).

async function setup() {
  const sent = await sentCampaign();
  const deps = await recordingDeps(sent.db);
  return {
    sent,
    u: mount("/u", createUnsubscribeRoutes({ deps: () => deps })),
    t: mount("/t", createTrackingRoutes({ deps: () => deps })),
  };
}

/** The href of the "Source code" link in the footer. */
function sourceLink(html: string): string | undefined {
  const footer = html.slice(html.indexOf("<footer>"));
  return /<a href="([^"]*)"[^>]*>\s*Source code\s*<\/a>/.exec(footer)?.[1];
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM system_settings WHERE key = ?").bind(SOURCE_URL_SETTING).run();
  await env.KV.delete(`settings:${SOURCE_URL_SETTING}`);
});

describe("the source link on public pages", () => {
  it("shows the default link and the version on the preference page", async () => {
    const { sent, u } = await setup();
    const html = await (await call(u, `/u/${sent.tokens[0]}`)).text();
    expect(sourceLink(html)).toBe(DEFAULT_SOURCE_URL);
    expect(html).toContain(`Sent with Envelopen ${ENVELOPEN_VERSION}`);
    expect(ENVELOPEN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows the owner's custom link on every public page after a change", async () => {
    const { sent, u, t } = await setup();
    const token = sent.tokens[0] as string;
    // Warm the cache with the default first, so the change must write through.
    expect(sourceLink(await (await call(u, `/u/${token}`)).text())).toBe(DEFAULT_SOURCE_URL);

    const custom = "https://git.example.com/acme/envelopen";
    await runOperation(
      sent.seeded.principal,
      settingsUpdate,
      { sourceUrl: custom },
      { db: sent.db, services: { settingsCache: settingsCache(env) } },
    );

    const pages: [ReturnType<typeof mount>, string, RequestInit?][] = [
      [u, `/u/${token}`],
      [u, `/u/${token}/preferences?step=confirm-all`],
      [u, "/u/test"],
      [u, "/u/x/y/z"],
      [t, "/t/invalid"],
      [t, "/t/nothing-here"],
      [
        u,
        `/u/${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ],
      // The contact is unsubscribed now: the "already unsubscribed" page.
      [u, `/u/${token}`],
    ];
    for (const [app, path, init] of pages) {
      const html = await (await call(app, path, init)).text();
      expect(sourceLink(html), path).toBe(custom);
      expect(html, path).toContain(ENVELOPEN_VERSION);
    }
  });

  it("escapes the link in the HTML", async () => {
    const { html } = await renderPage(
      { kind: "invalid" },
      'https://example.com/"><script>alert(1)</script>',
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
