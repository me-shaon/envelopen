import { readSourceUrl } from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import type { TokenSigner } from "@envelopen/email-render";
import { isUsableKey } from "../auth/better-auth";
import { type AttemptRule, attemptKeys, durableAttemptLimiter } from "../auth/rate-limit-do";
import { type EventSink, eventSink } from "../do/events";
import { type LedgerClient, unsubscribeLedger } from "../do/unsubscribes";
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
  /** The UnsubscribeLedger, for unsubscribes that D1 rejects at its daily limit (KTD1). */
  ledger: LedgerClient;
  /** Counts one ledger write for the IP. False when the IP is over LEDGER_IP_RULE. */
  allowLedgerWrite(ip: string): Promise<boolean>;
}

/**
 * Ledger writes per IP. A mail provider sends one-click POSTs for many subscribers from
 * few IPs, so the limit is high. It applies only while D1 rejects the normal write.
 */
export const LEDGER_IP_RULE: AttemptRule = { limit: 300, windowMs: 10 * 60 * 1000 };

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
    ledger: unsubscribeLedger(env),
    allowLedgerWrite: async (ip) => {
      const limiter = durableAttemptLimiter(env.AUTH_RATE_LIMITER);
      const status = await limiter.record(attemptKeys.ip("unsubscribe-ledger", ip), LEDGER_IP_RULE);
      return status.count <= LEDGER_IP_RULE.limit;
    },
  };
}
