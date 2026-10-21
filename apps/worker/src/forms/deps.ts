import {
  type CountLimiter,
  deriveHmacKey,
  hmacHex,
  readSourceUrl,
  type Services,
} from "@envelopen/core";
import { createDb, type DbConnection } from "@envelopen/db";
import { isUsableKey } from "../auth/better-auth";
import { type AttemptRule, durableAttemptLimiter } from "../auth/rate-limit-do";
import { pendingUnsubscribedContacts, unsubscribeLedger } from "../do/unsubscribes";
import { activeLimit, usageMeter, usageSink } from "../do/usage";
import { createServices, settingsCache } from "../services";
import {
  type TurnstileKeys,
  turnstileKeys,
  type VerifyRequest,
  type VerifyResult,
  verifyTurnstile,
} from "./turnstile";

// What the public form routes under /f need. Tests pass their own.

/** Submissions and resends from one IP in 10 minutes. Over it, the page says "check your inbox". */
export const FORM_IP_RULE: AttemptRule = { limit: 20, windowMs: 10 * 60 * 1000 };

export interface FormDeps {
  db: DbConnection;
  /** hashEmail, credentials, and outboundFetch for the confirmation email. */
  services: Partial<Services>;
  now(): number;
  sourceUrl(): Promise<string>;
  /** The Turnstile keys, or null when the deployment has none. */
  turnstile: TurnstileKeys | null;
  verifyTurnstile(request: VerifyRequest): Promise<VerifyResult>;
  /** Counters with a fixed window (the AuthRateLimiter DO, key namespace `form-`). */
  limiter: CountLimiter;
  usage(): Promise<{ limited: boolean; unsubscribesPending: boolean }>;
  pendingUnsubscribes(workspaceId: number, contactIds: readonly number[]): Promise<Set<number>>;
  /** A keyed hash of the client IP for the consent record, or null without SIGNING_KEY. */
  ipHash(ip: string): Promise<string | null>;
}

export type FormDepsFactory = (env: Env, request: Request) => FormDeps;

const IP_KEY_LABEL = "envelopen/forms/ip/v1";
let ipKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function ipHasher(signingKey: string | undefined) {
  return async (ip: string): Promise<string | null> => {
    if (!isUsableKey(signingKey) || ip === "unknown") return null;
    if (ipKey?.secret !== signingKey) {
      ipKey = { secret: signingKey, key: deriveHmacKey(signingKey, IP_KEY_LABEL) };
    }
    return hmacHex(await ipKey.key, ip);
  };
}

export function formDeps(env: Env, request: Request): FormDeps {
  const db = createDb(env, { usageSink: usageSink(env) });
  const services = createServices(env, request);
  const limiter = durableAttemptLimiter(env.AUTH_RATE_LIMITER);
  const keys = turnstileKeys(env);
  const fetcher = services.outboundFetch ?? fetch;
  return {
    db,
    services,
    now: () => Date.now(),
    sourceUrl: () => readSourceUrl(db, settingsCache(env)),
    turnstile: keys,
    verifyTurnstile: (verify) =>
      keys
        ? verifyTurnstile(fetcher, keys.secret, verify)
        : Promise.resolve({ ok: false, reason: "not-configured" }),
    limiter: { record: (key, rule) => limiter.record(key, rule) },
    usage: async () => {
      const status = await usageMeter(env).status();
      return {
        limited: activeLimit(status, Date.now()) !== null,
        unsubscribesPending: status.unsubscribesPending === true,
      };
    },
    pendingUnsubscribes: (workspaceId, contactIds) =>
      pendingUnsubscribedContacts(unsubscribeLedger(env), db, workspaceId, contactIds),
    ipHash: ipHasher(env.SIGNING_KEY),
  };
}
