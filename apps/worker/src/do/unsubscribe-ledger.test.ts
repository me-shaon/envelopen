import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { testLedger } from "../../test/campaign-helpers";
import type { UnsubscribeLedger } from "./unsubscribe-ledger";
import { type IntentInput, MAX_INTENTS } from "./unsubscribes";

// The UnsubscribeLedger Durable Object (KTD1). Each test has a ledger of its own, with
// a UsageMeter of its own for the pending flag.

function intent(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    campaignId: 1,
    recipientId: 10,
    workspaceId: null,
    contactId: null,
    listId: null,
    source: "one_click",
    at: 1_000,
    ...overrides,
  };
}

describe("UnsubscribeLedger", () => {
  it("stores intents, sets the UsageMeter flag, and clears it when the last one is removed", async () => {
    const ledger = testLedger();
    expect(await ledger.pending()).toBe(false);
    expect(await ledger.record([intent()])).toEqual({ stored: true, added: 1 });
    expect(await ledger.pending()).toBe(true);
    const [stored] = await ledger.list();
    expect(stored).toMatchObject({ recipientId: 10, listId: null, source: "one_click", at: 1_000 });
    expect(await ledger.remove([{ id: stored?.id ?? 0, at: 1_000 }])).toBe(0);
    expect(await ledger.pending()).toBe(false);
  });

  it("dedupes per recipient and scope, and per known contact and scope, and keeps the newest time", async () => {
    const ledger = testLedger();
    await ledger.record([intent({ at: 1_000 })]);
    expect(await ledger.record([intent({ at: 3_000 })])).toEqual({ stored: true, added: 0 });
    // Another email of the same contact, with the contact known.
    await ledger.record([intent({ recipientId: 11, workspaceId: 5, contactId: 7, at: 2_000 })]);
    await ledger.record([intent({ recipientId: 12, workspaceId: 5, contactId: 7, at: 4_000 })]);
    // A list scope is a separate intent.
    await ledger.record([intent({ listId: 3, at: 1_500 })]);
    const list = await ledger.list();
    expect(list.map((item) => [item.recipientId, item.listId, item.at])).toEqual([
      [10, 3, 1_500],
      [10, null, 3_000],
      [11, null, 4_000],
    ]);
    expect(await ledger.find({ recipientId: 99, workspaceId: 5, contactId: 7 })).toHaveLength(1);
    expect(await ledger.find({ recipientId: 10 })).toHaveLength(2);
  });

  it("keeps an intent whose time changed after the caller read it", async () => {
    const ledger = testLedger();
    await ledger.record([intent({ at: 1_000 })]);
    const [read] = await ledger.list();
    await ledger.record([intent({ at: 2_000 })]);
    expect(await ledger.remove([{ id: read?.id ?? 0, at: 1_000 }])).toBe(1);
    expect(await ledger.pending()).toBe(true);
  });

  it("ignores intents that are not valid", async () => {
    const ledger = testLedger();
    const bad = [{ ...intent(), recipientId: -1 }, { ...intent(), source: "admin" }, null];
    expect(await ledger.record(bad as IntentInput[])).toEqual({ stored: true, added: 0 });
    expect(await ledger.list()).toEqual([]);
    expect(await ledger.pending()).toBe(false);
  });

  it(`refuses new intents above ${MAX_INTENTS}, logs an alert, and counts the overflow`, async () => {
    const ledger = testLedger();
    const stub = env.UNSUBSCRIBE_LEDGER.getByName(ledger.name);
    await ledger.record([intent()]);
    await runInDurableObject(stub, async (_instance: UnsubscribeLedger, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
INSERT INTO intents (campaign_id, recipient_id, list_id, source, at)
SELECT 1, 1000 + i, 0, 'one_click', 1000 FROM n`,
        MAX_INTENTS - 1,
      );
    });
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await ledger.record([intent({ recipientId: 99 })])).toEqual({
        stored: false,
        reason: "full",
      });
    } finally {
      alert.mockRestore();
    }
    // A repeat of a stored intent still works: it adds no entry.
    expect(await ledger.record([intent({ at: 5_000 })])).toEqual({ stored: true, added: 0 });
    const stats = await stub.stats();
    expect(stats.waiting).toBe(MAX_INTENTS);
    expect(stats.overflow).toBe(1);
    expect(stats.overflowAt).not.toBeNull();
  });
});
