import { createDb, type DbConnection } from "@envelopen/db";
import type { TokenSigner } from "@envelopen/email-render";
import { isUsableKey } from "../auth/better-auth";
import { type EventSink, eventSink } from "../do/events";
import { usageSink } from "../do/usage";
import { tokenSigner } from "../services";
import { formToken } from "./csrf";

// What the public routes under /t and /u need. Tests pass their own sink and clock.

export interface TrackingDeps {
  db: DbConnection;
  signer(): Promise<TokenSigner>;
  /** Hands events of one workspace to its EventBuffer. */
  sink: EventSink;
  /** The hidden form field of the preference page of `token` (csrf.ts). */
  formToken(token: string): Promise<string>;
  now(): number;
}

export type TrackingDepsFactory = (env: Env) => TrackingDeps;

export function trackingDeps(env: Env): TrackingDeps {
  return {
    db: createDb(env, { usageSink: usageSink(env) }),
    signer: () => tokenSigner(env),
    sink: eventSink(env),
    formToken: (token) => {
      const key = env.SIGNING_KEY;
      if (!isUsableKey(key)) return Promise.reject(new Error("SIGNING_KEY is missing."));
      return formToken(key, token);
    },
    now: () => Date.now(),
  };
}
