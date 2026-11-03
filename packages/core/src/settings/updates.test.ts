import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb } from "../../test/fixtures";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { sessionPrincipal } from "../principal";
import {
  fetchLatestRelease,
  isNewerVersion,
  LATEST_RELEASE_URL_SETTING,
  LATEST_VERSION_SETTING,
  MANUAL_CHECK_INTERVAL_MS,
  parseReleaseVersion,
  runDailyUpdateCheck,
  UPDATE_CHECK_SETTING,
  UPDATE_CHECKED_AT_SETTING,
  updatesCheck,
  updatesGet,
  updatesUpdate,
} from "./updates";

const CURRENT = "0.5.0";
const RELEASE_URL = "https://github.com/me-shaon/envelopen/releases/tag/v0.6.0";

/** A fetch that answers each request with the next response, and records the URLs. */
function fakeFetch(...responses: (Response | Error)[]) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const next = responses.shift();
    if (!next) throw new Error("No more fake responses.");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetcher, urls };
}

const apiRelease = (tag = "v0.6.0") =>
  Response.json({
    tag_name: tag,
    html_url: `https://github.com/me-shaon/envelopen/releases/tag/${tag}`,
  });

async function owner() {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, "Updates");
  await conn.db
    .deleteFrom("system_settings")
    .where("key", "in", [
      UPDATE_CHECK_SETTING,
      LATEST_VERSION_SETTING,
      LATEST_RELEASE_URL_SETTING,
      UPDATE_CHECKED_AT_SETTING,
    ])
    .execute();
  return { conn, principal: sessionPrincipal({ workspaceId, userId }) };
}

describe("versions", () => {
  it("reads release tags and refuses other text", () => {
    expect(parseReleaseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseReleaseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseReleaseVersion("v1.2.3-rc.1")).toBeNull();
    expect(parseReleaseVersion("latest")).toBeNull();
  });

  it("compares each part as a number", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.5.0", "0.5.0")).toBe(false);
    expect(isNewerVersion("0.4.9", "0.5.0")).toBe(false);
    expect(isNewerVersion("nonsense", "0.5.0")).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  it("reads the newest release from the GitHub API", async () => {
    const { fetcher, urls } = fakeFetch(apiRelease());
    expect(await fetchLatestRelease(fetcher, CURRENT)).toEqual({
      version: "0.6.0",
      url: RELEASE_URL,
    });
    expect(urls).toEqual(["https://api.github.com/repos/me-shaon/envelopen/releases/latest"]);
  });

  it("returns null when the repository has no release", async () => {
    const { fetcher } = fakeFetch(Response.json({ message: "Not Found" }, { status: 404 }));
    expect(await fetchLatestRelease(fetcher, CURRENT)).toBeNull();
  });

  it("reads the release page when the API refuses", async () => {
    const { fetcher, urls } = fakeFetch(
      new Response("rate limited", { status: 403 }),
      new Response(null, { status: 302, headers: { location: RELEASE_URL } }),
    );
    expect(await fetchLatestRelease(fetcher, CURRENT)).toEqual({
      version: "0.6.0",
      url: RELEASE_URL,
    });
    expect(urls[1]).toBe("https://github.com/me-shaon/envelopen/releases/latest");
  });

  it("returns null when the release page has no release", async () => {
    const { fetcher } = fakeFetch(
      new Response("rate limited", { status: 429 }),
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/me-shaon/envelopen/releases" },
      }),
    );
    expect(await fetchLatestRelease(fetcher, CURRENT)).toBeNull();
  });

  it("refuses a tag that is not a version, and fails when both sources fail", async () => {
    const { fetcher } = fakeFetch(apiRelease("nightly"), new Error("offline"));
    await expect(fetchLatestRelease(fetcher, CURRENT)).rejects.toThrow(/nightly.*offline/);
  });
});

describe("update operations", () => {
  it("starts with the check on and no result", async () => {
    const { conn, principal } = await owner();
    const status = await runOperation(
      principal,
      updatesGet,
      {},
      { db: conn, services: { appVersion: CURRENT } },
    );
    expect(status).toEqual({
      enabled: true,
      currentVersion: CURRENT,
      latestVersion: null,
      releaseUrl: null,
      updateAvailable: false,
      checkedAt: null,
    });
  });

  it("checks now, stores the newer release, and shows it", async () => {
    const { conn, principal } = await owner();
    const { fetcher } = fakeFetch(apiRelease());
    const now = 1_800_000_000_000;
    const status = await runOperation(
      principal,
      updatesCheck,
      {},
      { db: conn, now: () => now, services: { appVersion: CURRENT, outboundFetch: fetcher } },
    );
    expect(status).toMatchObject({
      latestVersion: "0.6.0",
      releaseUrl: RELEASE_URL,
      updateAvailable: true,
      checkedAt: now,
    });
  });

  it("returns the stored result within a minute of the last check", async () => {
    const { conn, principal } = await owner();
    const now = 1_800_000_000_000;
    await runOperation(
      principal,
      updatesCheck,
      {},
      {
        db: conn,
        now: () => now,
        services: { appVersion: CURRENT, outboundFetch: fakeFetch(apiRelease()).fetcher },
      },
    );
    // A second request would fail, so the result must come from D1.
    const { fetcher, urls } = fakeFetch(new Error("not called"));
    const again = await runOperation(
      principal,
      updatesCheck,
      {},
      {
        db: conn,
        now: () => now + MANUAL_CHECK_INTERVAL_MS - 1,
        services: { appVersion: CURRENT, outboundFetch: fetcher },
      },
    );
    expect(again.checkedAt).toBe(now);
    expect(urls).toEqual([]);
  });

  it("reports GitHub failures as a provider error, and stores nothing", async () => {
    const { conn, principal } = await owner();
    const { fetcher } = fakeFetch(new Error("offline"), new Error("offline"));
    const error = await runOperation(
      principal,
      updatesCheck,
      {},
      { db: conn, services: { appVersion: CURRENT, outboundFetch: fetcher } },
    ).catch((caught: unknown) => caught);
    expect(isOperationError(error) && error.code).toBe("provider_error");
    const status = await runOperation(
      principal,
      updatesGet,
      {},
      { db: conn, services: { appVersion: CURRENT } },
    );
    expect(status.checkedAt).toBeNull();
  });

  it("does not show an older or equal release as an update", async () => {
    const { conn, principal } = await owner();
    const status = await runOperation(
      principal,
      updatesCheck,
      {},
      {
        db: conn,
        services: { appVersion: CURRENT, outboundFetch: fakeFetch(apiRelease("v0.5.0")).fetcher },
      },
    );
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBe("0.5.0");
  });

  it("turns the daily check off, and the cron then asks nothing", async () => {
    const { conn, principal } = await owner();
    const off = await runOperation(
      principal,
      updatesUpdate,
      { enabled: false },
      { db: conn, services: { appVersion: CURRENT } },
    );
    expect(off.enabled).toBe(false);
    const { fetcher, urls } = fakeFetch(apiRelease());
    expect(
      await runDailyUpdateCheck({ db: conn, outboundFetch: fetcher, currentVersion: CURRENT }, 1),
    ).toBe("off");
    expect(urls).toEqual([]);

    await runOperation(
      principal,
      updatesUpdate,
      { enabled: true },
      { db: conn, services: { appVersion: CURRENT } },
    );
    expect(
      await runDailyUpdateCheck({ db: conn, outboundFetch: fetcher, currentVersion: CURRENT }, 2),
    ).toBe("checked");
    const status = await runOperation(
      principal,
      updatesGet,
      {},
      { db: conn, services: { appVersion: CURRENT } },
    );
    expect(status).toMatchObject({ enabled: true, latestVersion: "0.6.0", checkedAt: 2 });
  });

  it("keeps the daily check quiet when GitHub fails", async () => {
    const { conn } = await owner();
    const { fetcher } = fakeFetch(new Error("offline"), new Error("offline"));
    expect(
      await runDailyUpdateCheck({ db: conn, outboundFetch: fetcher, currentVersion: CURRENT }, 1),
    ).toBe("failed");
  });
});
