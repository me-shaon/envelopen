import {
  applyUnsubscribeIntent,
  type BufferedEvent,
  type RecipientTarget,
  recipientTargets,
  type UnsubscribeSource,
} from "@envelopen/core";
import type { DbConnection } from "@envelopen/db";
import type { EventSink } from "./events";
import { USAGE_METER_NAME } from "./usage";

// Clients of the UnsubscribeLedger Durable Object (do/unsubscribe-ledger.ts, KTD1). They
// live apart from the class, so modules that Node.js also loads do not import
// `cloudflare:workers`.
//
// - `pendingUnsubscribedContacts`: the check of every send path while the UsageMeter flag
//   says that intents wait. The campaign send consumer uses it. Welcome steps and
//   confirmation emails use the same check.
// - `drainUnsubscribes`: the cron writes the intents to D1, oldest first, before it lifts
//   platform_limit.
// - `settleUnsubscribes`: the preference page writes the intents of its contact first,
//   so the page shows the real state and the subscriber's next action is the newest.

/** The one ledger of the deployment. */
export const LEDGER_NAME = "global";
/** The most intents that wait. Beyond it, `record` refuses new ones and logs an alert. */
export const MAX_INTENTS = 10_000;
/** The intents that one cron run writes to D1. Each takes one D1 batch. */
export const DRAIN_BATCH = 25;

export interface IntentInput {
  campaignId: number;
  recipientId: number;
  /** Known when D1 could read the recipient. Otherwise the drain looks it up. */
  workspaceId: number | null;
  contactId: number | null;
  /** The list to leave, or null for every list. */
  listId: number | null;
  source: UnsubscribeSource;
  /** When the subscriber asked, Unix milliseconds. */
  at: number;
}

export interface LedgerIntent extends IntentInput {
  id: number;
}

export type RecordResult = { stored: true; added: number } | { stored: false; reason: "full" };

export interface LedgerStats {
  waiting: number;
  /** Intents refused because the ledger was full. */
  overflow: number;
  overflowAt: number | null;
}

/** What callers need from the ledger. Tests can pass another instance. */
export interface LedgerClient {
  record(intents: IntentInput[]): Promise<RecordResult>;
  list(limit?: number): Promise<LedgerIntent[]>;
  find(ref: {
    recipientId: number;
    workspaceId?: number;
    contactId?: number;
  }): Promise<LedgerIntent[]>;
  remove(entries: { id: number; at: number }[]): Promise<number>;
}

export function unsubscribeLedger(
  env: Pick<Env, "UNSUBSCRIBE_LEDGER">,
  name = LEDGER_NAME,
): LedgerClient {
  return env.UNSUBSCRIBE_LEDGER.getByName(name) as unknown as LedgerClient;
}

/**
 * The UsageMeter that holds the flag of a ledger. The deployment's ledger uses the
 * deployment's meter. Another ledger (in tests) gets a meter of its own.
 */
export function ledgerMeterName(ledgerName: string | undefined): string {
  return ledgerName === undefined || ledgerName === LEDGER_NAME
    ? USAGE_METER_NAME
    : `ledger:${ledgerName}`;
}

const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isIntentInput(value: unknown): value is IntentInput {
  const intent = value as Partial<IntentInput> | null;
  return (
    intent !== null &&
    typeof intent === "object" &&
    id(intent.campaignId) &&
    id(intent.recipientId) &&
    (intent.workspaceId === null || id(intent.workspaceId)) &&
    (intent.contactId === null || id(intent.contactId)) &&
    (intent.listId === null || id(intent.listId)) &&
    (intent.source === "one_click" || intent.source === "preference_page") &&
    typeof intent.at === "number" &&
    Number.isFinite(intent.at)
  );
}

/**
 * The contacts in `contactIds` with an unsubscribe that waits in the ledger. A send path
 * skips them. Call it only while the UsageMeter flag says that intents wait. An intent
 * for one list skips the contact for every send until the drain, because the send path
 * cannot tell from the batch which list brought the contact in.
 */
export async function pendingUnsubscribedContacts(
  ledger: LedgerClient,
  db: DbConnection,
  workspaceId: number,
  contactIds: readonly number[],
): Promise<Set<number>> {
  const found = new Set<number>();
  if (contactIds.length === 0) return found;
  const intents = await ledger.list();
  const unknown: LedgerIntent[] = [];
  for (const intent of intents) {
    if (intent.contactId === null) unknown.push(intent);
    else if (intent.workspaceId === workspaceId) found.add(intent.contactId);
  }
  for (const target of (await recipientTargets(db, unknown, workspaceId)).values()) {
    found.add(target.contactId);
  }
  const wanted = new Set(contactIds);
  return new Set([...found].filter((contactId) => wanted.has(contactId)));
}

function unsubscribeEvent(intent: LedgerIntent, target: RecipientTarget): BufferedEvent {
  return {
    source: "tracking",
    type: "unsubscribe",
    campaignId: intent.campaignId,
    recipientId: intent.recipientId,
    contactId: target.contactId,
    linkId: null,
    machine: false,
    bot: false,
    reason: null,
    occurredAt: intent.at,
  };
}

export interface DrainReport {
  /** Intents that changed D1. */
  applied: number;
  /** Intents that changed nothing: a newer action won, or the contact is gone. */
  dropped: number;
  /** Intents that still wait in the ledger. */
  left: number;
}

/**
 * Writes the oldest intents to D1 through the unsubscribe write path, at most `max` per
 * call, and deletes them from the ledger. A D1 error stops the drain: the intents that
 * D1 has are deleted, and the error is thrown again.
 */
export async function drainUnsubscribes(
  db: DbConnection,
  ledger: LedgerClient,
  sink: EventSink,
  now: number,
  max = DRAIN_BATCH,
): Promise<DrainReport> {
  const report: DrainReport = { applied: 0, dropped: 0, left: 0 };
  const intents = await ledger.list(max);
  const done: { id: number; at: number }[] = [];
  const events = new Map<number, BufferedEvent[]>();
  try {
    const looked = await recipientTargets(
      db,
      intents.filter((intent) => intent.contactId === null),
    );
    for (const intent of intents) {
      const target =
        intent.workspaceId !== null && intent.contactId !== null
          ? { workspaceId: intent.workspaceId, contactId: intent.contactId }
          : looked.get(intent.recipientId);
      if (target) {
        const changed = await applyUnsubscribeIntent(
          db,
          {
            workspaceId: target.workspaceId,
            contactId: target.contactId,
            campaignId: intent.campaignId,
            listId: intent.listId,
            source: intent.source,
            at: intent.at,
          },
          now,
        );
        if (changed) {
          report.applied++;
          const list = events.get(target.workspaceId) ?? [];
          list.push(unsubscribeEvent(intent, target));
          events.set(target.workspaceId, list);
        } else report.dropped++;
      } else report.dropped++;
      done.push({ id: intent.id, at: intent.at });
    }
  } finally {
    // An empty call still clears a flag that an earlier run left set.
    report.left = await ledger.remove(done);
  }
  for (const [workspaceId, list] of events) {
    await sink(workspaceId, list).catch((error) =>
      console.error("Unsubscribe events of the drain failed", error),
    );
  }
  return report;
}

/**
 * Writes the waiting intents of one contact to D1, as the drain does. The preference page
 * calls it while D1 works, before it shows the page or applies a form. Returns true when
 * an intent was there, so the caller reads the contact again.
 */
export async function settleUnsubscribes(
  db: DbConnection,
  ledger: LedgerClient,
  sink: EventSink,
  target: { workspaceId: number; contactId: number; recipientId: number },
  now: number,
): Promise<boolean> {
  const intents = await ledger.find(target);
  if (intents.length === 0) return false;
  const events: BufferedEvent[] = [];
  for (const intent of intents) {
    const changed = await applyUnsubscribeIntent(
      db,
      {
        workspaceId: target.workspaceId,
        contactId: target.contactId,
        campaignId: intent.campaignId,
        listId: intent.listId,
        source: intent.source,
        at: intent.at,
      },
      now,
    );
    if (changed) events.push(unsubscribeEvent(intent, target));
  }
  await ledger.remove(intents.map((intent) => ({ id: intent.id, at: intent.at })));
  if (events.length > 0) await sink(target.workspaceId, events);
  return true;
}
