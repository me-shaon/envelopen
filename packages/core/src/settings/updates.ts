import type { DbConnection } from "@envelopen/db";
import { z } from "zod";
import { OperationError } from "../errors";
import { defineOperation } from "../registry/operation";
import { requireService } from "../services";

// The update check. Once a day the cron asks GitHub for the newest release of the upstream
// repository. Settings shows the running version, the newest release, and a "Check now"
// button. The owner can turn the daily check off. The check sends no workspace data: it is
// one request for the public release of me-shaon/envelopen.
//
// The state lives in the global `system_settings` table, like the other deployment
// settings, so it needs no migration. Only the owner session can read or change it, and
// never through MCP.

/** The repository that publishes the releases. Copies made by the Deploy button check it too. */
export const UPSTREAM_REPO = "me-shaon/envelopen";

/** `system_settings` keys of the update check. */
export const UPDATE_CHECK_SETTING = "update_check";
export const LATEST_VERSION_SETTING = "latest_version";
export const LATEST_RELEASE_URL_SETTING = "latest_release_url";
export const UPDATE_CHECKED_AT_SETTING = "update_checked_at";

const UPDATE_KEYS = [
  UPDATE_CHECK_SETTING,
  LATEST_VERSION_SETTING,
  LATEST_RELEASE_URL_SETTING,
  UPDATE_CHECKED_AT_SETTING,
];

const RELEASE_TIMEOUT_MS = 10_000;

/**
 * The shortest time between two checks that the owner starts. GitHub allows 60 API requests
 * an hour per IP address without a token, and Workers share IP addresses.
 */
export const MANUAL_CHECK_INTERVAL_MS = 60_000;

export interface Release {
  /** Without the "v" prefix, for example "0.6.0". */
  version: string;
  url: string;
}

/** "v1.2.3" or "1.2.3" as [1, 2, 3]. Null for any other text, also for pre-releases. */
export function parseReleaseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a higher version than `current`. False when either is not valid. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseReleaseVersion(candidate);
  const b = parseReleaseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The release from a tag and its page URL. Throws when the tag is not a version. */
function releaseOf(tag: string, url: string): Release {
  const parsed = parseReleaseVersion(tag);
  if (!parsed || !url.startsWith("https://github.com/")) {
    throw new Error(`GitHub sent a release with the tag "${tag.slice(0, 40)}"`);
  }
  return { version: parsed.join("."), url };
}

/** The newest release from the GitHub API. Null when the repository has no release. */
async function fetchFromApi(fetcher: typeof fetch, version: string): Promise<Release | null> {
  const res = await fetcher(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `envelopen/${version}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  return releaseOf(
    typeof body.tag_name === "string" ? body.tag_name : "",
    typeof body.html_url === "string" ? body.html_url : "",
  );
}

/**
 * The newest release from the redirect of the public "latest release" page. It does not
 * count against the API limit. With no release, GitHub redirects to the release list.
 */
async function fetchFromReleasePage(
  fetcher: typeof fetch,
  version: string,
): Promise<Release | null> {
  const res = await fetcher(`https://github.com/${UPSTREAM_REPO}/releases/latest`, {
    method: "HEAD",
    headers: { "user-agent": `envelopen/${version}` },
    redirect: "manual",
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new Error(`The release page answered ${res.status}`);
  }
  const url = new URL(location, "https://github.com").href;
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(new URL(url).pathname)?.[1];
  if (!tag) return null;
  return releaseOf(decodeURIComponent(tag), url);
}

/**
 * The newest published release. GitHub leaves out drafts and pre-releases. Null when the
 * repository has no release yet. Throws when GitHub does not answer or the answer is wrong.
 *
 * Without a token, the GitHub API allows 60 requests an hour per IP address, and Workers
 * share IP addresses, so the API often refuses with 403 or 429. The release page is then
 * the second source.
 */
export async function fetchLatestRelease(
  fetcher: typeof fetch,
  version: string,
): Promise<Release | null> {
  try {
    return await fetchFromApi(fetcher, version);
  } catch (apiError) {
    try {
      return await fetchFromReleasePage(fetcher, version);
    } catch (pageError) {
      const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
      throw new Error(`${reason(apiError)}. ${reason(pageError)}.`);
    }
  }
}

export const UpdateStatusSchema = z
  .object({
    enabled: z.boolean().meta({
      description: "When false, the daily check does not ask GitHub for new releases.",
    }),
    currentVersion: z.string().meta({ description: "The version that this deployment runs." }),
    latestVersion: z.string().nullable().meta({
      description: "The newest release on GitHub at the last check. Null before the first check.",
    }),
    releaseUrl: z.string().nullable().meta({ description: "The page of the newest release." }),
    updateAvailable: z.boolean(),
    checkedAt: z
      .number()
      .int()
      .nullable()
      .meta({ description: "Unix milliseconds of the last successful check." }),
  })
  .meta({ id: "UpdateStatus" });

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

interface StoredUpdate {
  enabled: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: number | null;
}

async function readStored(db: DbConnection): Promise<StoredUpdate> {
  // `system_settings` is a global table, so no workspace filter applies.
  const rows = await db.db
    .selectFrom("system_settings")
    .select(["key", "value"])
    .where("key", "in", UPDATE_KEYS)
    .execute();
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  const checkedAt = Number(value(UPDATE_CHECKED_AT_SETTING));
  const latest = value(LATEST_VERSION_SETTING);
  return {
    enabled: value(UPDATE_CHECK_SETTING) !== "off",
    latestVersion: latest && parseReleaseVersion(latest) ? latest : null,
    releaseUrl: value(LATEST_RELEASE_URL_SETTING),
    checkedAt: Number.isSafeInteger(checkedAt) && checkedAt > 0 ? checkedAt : null,
  };
}

function statusOf(stored: StoredUpdate, currentVersion: string): UpdateStatus {
  return {
    ...stored,
    currentVersion,
    updateAvailable:
      stored.latestVersion !== null && isNewerVersion(stored.latestVersion, currentVersion),
  };
}

/** The running version, the newest release at the last check, and the switch. */
export async function readUpdateStatus(
  db: DbConnection,
  currentVersion: string,
): Promise<UpdateStatus> {
  return statusOf(await readStored(db), currentVersion);
}

async function putSettings(db: DbConnection, values: Record<string, string>, now: number) {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value, updated_at: now }));
  await db.db
    .insertInto("system_settings")
    .values(rows)
    .onConflict((oc) =>
      oc.column("key").doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        updated_at: eb.ref("excluded.updated_at"),
      })),
    )
    .execute();
}

async function recordRelease(db: DbConnection, release: Release | null, now: number) {
  await putSettings(
    db,
    {
      [LATEST_VERSION_SETTING]: release?.version ?? "",
      [LATEST_RELEASE_URL_SETTING]: release?.url ?? "",
      [UPDATE_CHECKED_AT_SETTING]: String(now),
    },
    now,
  );
}

/**
 * The daily check of the cron. It does nothing when the owner turned the check off. A failed
 * check is not the owner's problem: it logs the error, and tomorrow's check tries again.
 */
export async function runDailyUpdateCheck(
  deps: { db: DbConnection; outboundFetch: typeof fetch; currentVersion: string },
  now: number,
): Promise<"checked" | "off" | "failed"> {
  const stored = await readStored(deps.db);
  if (!stored.enabled) return "off";
  let release: Release | null;
  try {
    release = await fetchLatestRelease(deps.outboundFetch, deps.currentVersion);
  } catch (error) {
    console.warn("The update check failed", error);
    return "failed";
  }
  await recordRelease(deps.db, release, now);
  return "checked";
}

const UPDATES_MCP = {
  class: "never",
  reason: "Deployment settings are for the owner. API keys cannot hold the workspace:admin scope.",
} as const;

export const updatesGet = defineOperation({
  id: "updates.get",
  summary: "Get the update status",
  description:
    "Returns the version that this deployment runs, the newest release of Envelopen on " +
    "GitHub at the last check, and whether the daily check is on.",
  method: "get",
  path: "/settings/updates",
  scope: "workspace:admin",
  risk: "read",
  mcp: UPDATES_MCP,
  input: z.object({}),
  output: UpdateStatusSchema,
  async handler(_input, { db, services }) {
    return readUpdateStatus(db, requireService(services, "appVersion"));
  },
});

export const updatesUpdate = defineOperation({
  id: "updates.update",
  summary: "Turn the daily update check on or off",
  description:
    "Turns the daily check for new Envelopen releases on or off. The check asks GitHub for " +
    "the newest release of me-shaon/envelopen, and sends no workspace data.",
  method: "patch",
  path: "/settings/updates",
  scope: "workspace:admin",
  risk: "write",
  mcp: UPDATES_MCP,
  input: z.object({
    enabled: z.boolean().meta({ description: "True to check GitHub once a day." }),
  }),
  output: UpdateStatusSchema,
  async handler(input, { db, now, services }) {
    await putSettings(db, { [UPDATE_CHECK_SETTING]: input.enabled ? "on" : "off" }, now);
    return readUpdateStatus(db, requireService(services, "appVersion"));
  },
  auditTarget: (input) => ({
    targetType: "deployment_settings",
    metadata: { updateCheck: input.enabled },
  }),
});

export const updatesCheck = defineOperation({
  id: "updates.check",
  summary: "Check for a new release now",
  description:
    "Asks GitHub for the newest release now, and returns the new status. Within a minute of " +
    "the last check, it returns the stored result. It works when the daily check is off too.",
  method: "post",
  path: "/settings/updates/check",
  scope: "workspace:admin",
  // It stores the result of the check.
  risk: "write",
  mcp: UPDATES_MCP,
  input: z.object({}),
  output: UpdateStatusSchema,
  async handler(_input, { db, now, services }) {
    const currentVersion = requireService(services, "appVersion");
    const stored = await readStored(db);
    if (stored.checkedAt !== null && now - stored.checkedAt < MANUAL_CHECK_INTERVAL_MS) {
      return statusOf(stored, currentVersion);
    }
    let release: Release | null;
    try {
      release = await fetchLatestRelease(requireService(services, "outboundFetch"), currentVersion);
    } catch (error) {
      console.warn("The update check failed", error);
      throw new OperationError(
        "provider_error",
        "Could not reach GitHub. Try again in a few minutes.",
      );
    }
    await recordRelease(db, release, now);
    return readUpdateStatus(db, currentVersion);
  },
});
