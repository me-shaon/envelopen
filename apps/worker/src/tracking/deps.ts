import { readSourceUrl } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import type { TokenSigner } from "@envelopen/email-render";
import { isUsableKey } from "../auth/better-auth";
import { type EventSink, eventSink } from "../do/events";
import { usageSink } from "../do/usage";
import { settingsCache, tokenSigner } from "../services";
import { formToken } from "./csrf";

// What the public routes under /t and /u need. Tests pass their own sink and clock.

export interface TrackingDeps {
  db: DbConnection;
  signer(): Promise<TokenSigner>;
  /** Hands events of one workspace to its EventBuffer. */
  sink: EventSink;
  /** The hidden form field of the preference page of `token` (csrf.ts). */
  formToken(token: string): Promise<string>;
  /** The source link for the page footer (KTD16). Cached in KV. It never throws. */
  sourceUrl(): Promise<string>;
  now(): number;
}

export type TrackingDepsFactory = (env: Env) => TrackingDeps;

export function trackingDeps(env: Env): TrackingDeps {
  const db = createDb(env, { usageSink: usageSink(env) });
  return {
    db,
    signer: () => tokenSigner(env),
    sink: eventSink(env),
    formToken: (token) => {
      const key = env.SIGNING_KEY;
      if (!isUsableKey(key)) return Promise.reject(new Error("SIGNING_KEY is missing."));
      return formToken(key, token);
    },
    sourceUrl: () => readSourceUrl(db, settingsCache(env)),
    now: () => Date.now(),
  };
}
