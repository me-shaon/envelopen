import type { DbConnection } from "@envelopen/db";
import { z } from "zod";
import { defineOperation } from "../registry/operation";
import type { SettingsCache } from "../services";

// Deployment settings (KTD16). They apply to the whole deployment, not to one workspace,
// so they live in the global `system_settings` table. Only the owner session can read or
// change them (workspace:admin), and never through MCP.
//
// The source link (AGPL section 13, R6) shows in the admin footer and on every public
// subscriber page. The public pages read it through a cache (KV in the Worker), so a
// page view costs no D1 read in the common case. A change writes the new value to the
// cache at once. Edge copies of the old value expire within a few minutes.

/** The upstream repository. Each deployment links here until the owner sets another URL. */
export const DEFAULT_SOURCE_URL = "https://github.com/me-shaon/envelopen";

/** The `system_settings` key of the source link. */
export const SOURCE_URL_SETTING = "source_url";

const MAX_URL_LENGTH = 500;

/** True for an absolute https URL with a host. Every other scheme is rejected. */
export function isHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
  );
}

export const SourceUrlSchema = z
  .string()
  .trim()
  .min(1, "Enter the URL of the source code.")
  .max(MAX_URL_LENGTH, `Use ${MAX_URL_LENGTH} characters or fewer.`)
  .refine(isHttpsUrl, "Enter a full URL that starts with https://.");

export const DeploymentSettingsSchema = z
  .object({
    sourceUrl: z.string().meta({ description: "The link to the source code of this deployment." }),
    defaultSourceUrl: z.string().meta({ description: "The upstream repository URL." }),
  })
  .meta({ id: "DeploymentSettings" });

/** Reads the stored source link. A missing or invalid value gives the default. */
async function storedSourceUrl(db: DbConnection): Promise<string> {
  // `system_settings` is a global table, so no workspace filter applies.
  const row = await db.db
    .selectFrom("system_settings")
    .select("value")
    .where("key", "=", SOURCE_URL_SETTING)
    .executeTakeFirst();
  return row && isHttpsUrl(row.value) ? row.value : DEFAULT_SOURCE_URL;
}

/**
 * The source link for the public pages. It reads the cache first, then D1, and fills the
 * cache on a miss. It never throws: on any failure the page links to the default.
 */
export async function readSourceUrl(db: DbConnection, cache?: SettingsCache): Promise<string> {
  try {
    const cached = await cache?.get(SOURCE_URL_SETTING);
    if (cached && isHttpsUrl(cached)) return cached;
  } catch (error) {
    console.error("The settings cache read failed", error);
  }
  let value: string;
  try {
    value = await storedSourceUrl(db);
  } catch (error) {
    console.error("The source link read failed", error);
    return DEFAULT_SOURCE_URL;
  }
  try {
    await cache?.put(SOURCE_URL_SETTING, value);
  } catch (error) {
    console.error("The settings cache write failed", error);
  }
  return value;
}

const SETTINGS_MCP = {
  class: "never",
  reason: "Deployment settings are for the owner. API keys cannot hold the workspace:admin scope.",
} as const;

export const settingsGet = defineOperation({
  id: "settings.get",
  summary: "Get the deployment settings",
  description:
    "Returns the settings of the whole deployment: the link to the source code that the " +
    "admin app and the public subscriber pages show (AGPL section 13).",
  method: "get",
  path: "/settings",
  scope: "workspace:admin",
  risk: "read",
  mcp: SETTINGS_MCP,
  input: z.object({}),
  output: DeploymentSettingsSchema,
  async handler(_input, { db }) {
    return { sourceUrl: await storedSourceUrl(db), defaultSourceUrl: DEFAULT_SOURCE_URL };
  },
});

export const settingsUpdate = defineOperation({
  id: "settings.update",
  summary: "Update the deployment settings",
  description:
    "Sets the link to the source code of this deployment. The admin app and every public " +
    "subscriber page show it. Only https URLs are accepted.",
  method: "patch",
  path: "/settings",
  scope: "workspace:admin",
  risk: "write",
  mcp: SETTINGS_MCP,
  input: z.object({ sourceUrl: SourceUrlSchema }),
  output: DeploymentSettingsSchema,
  async handler(input, { db, now, services }) {
    await db.db
      .insertInto("system_settings")
      .values({ key: SOURCE_URL_SETTING, value: input.sourceUrl, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: input.sourceUrl, updated_at: now }))
      .execute();
    // Write through, so the public pages show the new link without a wait for expiry.
    // A failed cache write is not fatal: the cached copy expires on its own.
    try {
      await services.settingsCache?.put(SOURCE_URL_SETTING, input.sourceUrl);
    } catch (error) {
      console.error("The settings cache write failed", error);
    }
    return { sourceUrl: input.sourceUrl, defaultSourceUrl: DEFAULT_SOURCE_URL };
  },
  auditTarget: (input) => ({
    targetType: "deployment_settings",
    metadata: { sourceUrl: input.sourceUrl },
  }),
});
