import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type BufferedEvent, readSourceUrl } from "@envelopen/core";
import type { SeedOptions } from "@envelopen/core/testing/campaign-fixtures";
import type { DbConnection } from "@envelopen/db";
import { Hono } from "hono";
import { processPointer } from "../src/queue/send-consumer";
import { settingsCache } from "../src/services";
import { formToken } from "../src/tracking/csrf";
import type { TrackingDeps } from "../src/tracking/deps";
import {
  recipientRows,
  type SendingCampaign,
  SIGNING_KEY,
  sendingCampaign,
  T0,
  testDeps,
  testKeys,
} from "./campaign-helpers";

// Shared setup of the tracking, unsubscribe, and EventBuffer tests: a campaign that the
// consumer sent through the provider mock, with each recipient's signed token.

export const ORIGIN = "https://envelopen.test";
/** The consumer's clock sends at T0 + 1 s. Hits use a later time, past the bot window. */
export const SENT_AT = T0 + 1000;
export const LATER = T0 + 10 * 60 * 1000;

export interface SentEmail {
  to: string;
  html: string;
  headers: Record<string, string>;
}

export interface SentCampaign extends SendingCampaign {
  recipients: Awaited<ReturnType<typeof recipientRows>>;
  tokens: string[];
  emails: SentEmail[];
}

export async function sentCampaign(options: SeedOptions = {}): Promise<SentCampaign> {
  const sending = await sendingCampaign({ provider: "resend", contacts: 2, ...options });
  const deps = await testDeps(sending.db);
  for (const pointer of sending.pointers) await processPointer(deps, pointer);
  const recipients = await recipientRows(
    sending.db,
    sending.seeded.workspaceId,
    sending.campaignId,
  );
  const { signer } = await testKeys();
  const tokens = await Promise.all(
    recipients.map((row) => signer.sign({ campaignId: sending.campaignId, recipientId: row.id })),
  );
  const emails = deps.mock.calls.flatMap((call) => JSON.parse(call.body || "[]") as SentEmail[]);
  return { ...sending, recipients, tokens, emails };
}

export interface RecordingDeps extends TrackingDeps {
  events: { workspaceId: number; event: BufferedEvent }[];
  clock: { now: number };
}

/** Tracking dependencies with a sink that records the events instead of buffering them. */
export async function recordingDeps(db: DbConnection, now = LATER): Promise<RecordingDeps> {
  const { signer } = await testKeys();
  const events: RecordingDeps["events"] = [];
  const clock = { now };
  return {
    db,
    signer: async () => signer,
    sink: async (workspaceId, list) => {
      for (const event of list) events.push({ workspaceId, event });
    },
    formToken: (token) => formToken(SIGNING_KEY, token),
    sourceUrl: () => readSourceUrl(db, settingsCache(env)),
    now: () => clock.now,
    events,
    clock,
  };
}

/** Mounts a route group at its path, as the Worker entry does. */
export function mount(path: string, routes: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
  return new Hono<{ Bindings: Env }>().route(path, routes);
}

/** Sends a request to a route group and waits for its `waitUntil` work. */
export async function call(
  app: Hono<{ Bindings: Env }>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init });
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** The path of a URL on the tracking origin. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
