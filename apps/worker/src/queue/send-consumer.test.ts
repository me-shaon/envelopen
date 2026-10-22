import { env } from "cloudflare:workers";
import {
  campaignsGet,
  claimBatch,
  expireLeases,
  LEASE_MS,
  redispatchWaiting,
  runOperation,
  type SweepDeps,
  sessionPrincipal,
} from "@envelopen/core";
import { addContacts } from "@envelopen/core/testing/campaign-fixtures";
import { getAdapter } from "@envelopen/providers";
import { mockSmtp, parseMail } from "@envelopen/providers/conformance/mock-smtp";
import { describe, expect, it } from "vitest";
import {
  batchRow,
  campaignDb,
  campaignRow,
  countingD1,
  dbOver,
  limitedD1,
  recipientRows,
  recordingQueue,
  sendingCampaign,
  snapshot,
  T0,
  testDeps,
  testKeys,
  testLedger,
} from "../../test/campaign-helpers";
import { runCampaignCron } from "../cron";
import { rateLimiterFor, rateRule, reserve } from "../do/rate-limiter";
import {
  DRAIN_BATCH,
  type IntentInput,
  ledgerMeterName,
  pendingUnsubscribedContacts,
} from "../do/unsubscribes";
import { usageMeter, usageReader } from "../do/usage";
import { consumerDeps, MAX_RATE_WAIT_MS, processPointer } from "./send-consumer";

// The send consumer (U9). The execution note of the plan asks for the redelivery,
// stale-generation, and pause tests first: they are the first three groups here.
// Each test drives the consumer with explicit pointers and a provider mock, on the
// real local D1.

function sweepDeps(db: SweepDeps["db"], now: number) {
  const queue = recordingQueue();
  return { db, queue, startCampaignJob: async () => {}, now } satisfies SweepDeps & {
    queue: typeof queue;
  };
}

describe("redelivery", () => {
  it("makes one provider call for two deliveries of one batch", async () => {
    const { db, seeded, pointers } = await sendingCampaign({ contacts: 3 });
    expect(pointers).toHaveLength(1);
    const deps = await testDeps(db);
    const [first, second] = await Promise.all([
      processPointer(deps, pointers[0]),
      processPointer(deps, pointers[0]),
    ]);
    expect([first.result, second.result].sort()).toEqual(["duplicate", "sent"]);
    expect(deps.mock.calls).toHaveLength(1);
    expect(deps.mock.delivered.sort()).toEqual([
      "student1@example.org",
      "student2@example.org",
      "student3@example.org",
    ]);
    // A third delivery after the results finds the campaign sent and drops the message.
    expect(await processPointer(deps, pointers[0])).toEqual({ action: "ack", result: "inactive" });
    expect(deps.mock.calls).toHaveLength(1);
    const batch = await batchRow(db, seeded.workspaceId, pointers[0]?.batchId as number);
    expect(batch).toMatchObject({ status: "done", sent_count: 3 });
  });
});

describe("stale generation", () => {
  it("drops a message with a stale generation without a send or a state write", async () => {
    const { db, seeded, pointers } = await sendingCampaign({ contacts: 2 });
    const pointer = pointers[0] as (typeof pointers)[number];
    const deps = await testDeps(db);
    const before = await batchRow(db, seeded.workspaceId, pointer.batchId);
    const recipientsBefore = await recipientRows(db, seeded.workspaceId, pointer.campaignId);
    const writes = db.meter.rowsWritten;
    const outcome = await processPointer(deps, { ...pointer, generation: pointer.generation - 1 });
    expect(outcome).toEqual({ action: "ack", result: "stale" });
    expect(deps.mock.calls).toHaveLength(0);
    expect(db.meter.rowsWritten).toBe(writes);
    expect(await batchRow(db, seeded.workspaceId, pointer.batchId)).toEqual(before);
    expect(await recipientRows(db, seeded.workspaceId, pointer.campaignId)).toEqual(
      recipientsBefore,
    );
  });
});

describe("pause", () => {
  it("drops messages while paused, and resume sends them with a new generation", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const pointer = pointers[0] as (typeof pointers)[number];
    await db.db
      .updateTable("campaigns")
      .set({ status: "paused", pause_reason: "manual" })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", campaignId)
      .execute();
    const deps = await testDeps(db);
    const writes = db.meter.rowsWritten;
    expect(await processPointer(deps, pointer)).toEqual({ action: "ack", result: "inactive" });
    expect(deps.mock.calls).toHaveLength(0);
    expect(db.meter.rowsWritten).toBe(writes);

    const { campaignsResume } = await import("@envelopen/core");
    const queue = recordingQueue();
    await runOperation(
      seeded.principal,
      campaignsResume,
      { id: campaignId },
      {
        db,
        services: { sendQueue: queue },
        now: () => T0 + 5000,
      },
    );
    expect(queue.sent).toEqual([{ ...pointer, generation: pointer.generation + 1 }]);
    // The old message is stale now. The new one sends.
    expect((await processPointer(deps, pointer)).result).toBe("stale");
    expect((await processPointer(deps, queue.sent[0])).result).toBe("sent");
    expect(deps.mock.calls).toHaveLength(1);
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });
});

describe("exactly once and uncertain batches", () => {
  it("covers AE3: an SES batch whose lease expires becomes uncertain, and other batches continue", async () => {
    // 30 recipients on SES (batch size 25): two batches.
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "ses",
      contacts: 30,
    });
    expect(pointers).toHaveLength(2);
    const deps = await testDeps(db);
    // The first batch times out at the provider.
    let timeouts = true;
    deps.mock.respond = () => {
      if (!timeouts) return undefined;
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    expect((await processPointer(deps, pointers[0])).result).toBe("unknown");
    expect(await batchRow(db, seeded.workspaceId, pointers[0]?.batchId as number)).toMatchObject({
      status: "claimed",
      sent_count: 0,
    });
    timeouts = false;
    expect((await processPointer(deps, pointers[1])).result).toBe("sent");

    // The sweep after the lease: uncertain, never sent again without a decision.
    const sweep = sweepDeps(db, T0 + 1000 + LEASE_MS + 1);
    // The sweep runs across workspaces, so other tests' batches can show up too.
    const leases = await expireLeases(sweep);
    expect(leases.uncertain).toContain(pointers[0]?.batchId);
    expect(sweep.queue.sent.filter((item) => item.campaignId === campaignId)).toEqual([]);
    const calls = deps.mock.calls.length;
    expect((await processPointer(deps, pointers[0])).result).toBe("not_enqueued");
    expect(deps.mock.calls).toHaveLength(calls);

    const { finalizeIdle } = await import("@envelopen/core");
    expect(await finalizeIdle(sweep)).toContainEqual({ id: campaignId, status: "needs_decision" });
    const detail = await runOperation(seeded.principal, campaignsGet, { id: campaignId }, { db });
    expect(detail.progress).toMatchObject({ sent: 5, uncertain: 25, pending: 0 });
  });

  it("moves a batch that a crashed consumer claimed to uncertain on SES", async () => {
    const { db, seeded, pointers } = await sendingCampaign({ provider: "ses", contacts: 2 });
    const pointer = pointers[0] as (typeof pointers)[number];
    // The claim commits, then the consumer dies before the provider call.
    const claim = await claimBatch(
      db,
      pointer,
      {
        frozen: { v: 1, origin: "https://envelopen.test", recipients: [], skipped: [] },
        idempotencyKey: null,
        leaseUntil: T0 + LEASE_MS,
      },
      T0,
    );
    expect(claim).not.toBeNull();
    expect((await expireLeases(sweepDeps(db, T0 + LEASE_MS - 1))).uncertain).not.toContain(
      pointer.batchId,
    );
    expect((await batchRow(db, seeded.workspaceId, pointer.batchId)).status).toBe("claimed");
    expect((await expireLeases(sweepDeps(db, T0 + LEASE_MS + 1))).uncertain).toContain(
      pointer.batchId,
    );
    expect((await batchRow(db, seeded.workspaceId, pointer.batchId)).status).toBe("uncertain");
  });

  it("retries a Resend batch with a byte-identical payload and the same key, also after a sweep re-dispatch", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "resend",
      contacts: 3,
    });
    const pointer = pointers[0] as (typeof pointers)[number];
    const deps = await testDeps(db);
    let fail = true;
    deps.mock.respond = () =>
      fail
        ? new Response(JSON.stringify({ name: "internal_server_error" }), { status: 500 })
        : undefined;
    expect((await processPointer(deps, pointer)).result).toBe("unknown");
    // Nothing is recorded, so the retry can send the same payload.
    expect(await batchRow(db, seeded.workspaceId, pointer.batchId)).toMatchObject({
      status: "claimed",
      sent_count: 0,
    });

    // Between the attempts, a contact changes its name and another is suppressed. The
    // retry must not notice: same bytes, same key (KTD18).
    const { hashEmail } = await testKeys();
    await db.db
      .updateTable("contacts")
      .set({ first_name: "Changed" })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "student1@example.org")
      .execute();
    await db.db
      .insertInto("suppressions")
      .values({
        workspace_id: seeded.workspaceId,
        email_hash: await hashEmail("student2@example.org"),
        reason: "hard_bounce",
        source: "test",
        campaign_id: null,
      })
      .execute();

    const sweep = sweepDeps(db, deps.clock.now + LEASE_MS + 1);
    const leases = await expireLeases(sweep);
    expect(leases.retried).toContain(pointer.batchId);
    expect(leases.uncertain).not.toContain(pointer.batchId);
    const retryPointer = sweep.queue.sent.find((item) => item.batchId === pointer.batchId);
    expect(retryPointer).toEqual({ ...pointer, generation: pointer.generation + 1 });
    fail = false;
    deps.clock.now = sweep.now + 1;
    expect((await processPointer(deps, retryPointer)).result).toBe("sent");

    const [first, retry] = deps.mock.calls;
    expect(retry?.body).toBe(first?.body);
    expect(retry?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(first?.headers["idempotency-key"]).toMatch(/^envelopen-/);
    expect(await batchRow(db, seeded.workspaceId, pointer.batchId)).toMatchObject({
      status: "done",
      sent_count: 3,
    });
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });

  it("keeps the set and the key after a refusal that follows an unknown attempt, so nobody gets two copies", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "resend",
      contacts: 3,
    });
    const pointer = pointers[0] as (typeof pointers)[number];
    const deps = await testDeps(db);
    // Attempt 1: Resend may have accepted the batch, but the answer is lost.
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "internal_server_error" }), { status: 500 });
    expect((await processPointer(deps, pointer)).result).toBe("unknown");
    const claimed = await batchRow(db, seeded.workspaceId, pointer.batchId);
    expect(claimed.recipient_set).not.toBeNull();
    expect(claimed.idempotency_key).toMatch(/^envelopen-/);

    // The lease expires, and the sweep sends a retry pointer with the stored set and key.
    const sweep = sweepDeps(db, deps.clock.now + LEASE_MS + 1);
    expect((await expireLeases(sweep)).retried).toContain(pointer.batchId);
    const retryPointer = sweep.queue.sent.find((item) => item.batchId === pointer.batchId);

    // Attempt 2: a 429. The batch waits, and keeps the set and the key.
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "2" },
      });
    deps.clock.now = sweep.now + 1;
    expect((await processPointer(deps, retryPointer)).result).toBe("returned");
    expect(await batchRow(db, seeded.workspaceId, pointer.batchId)).toMatchObject({
      status: "pending",
      recipient_set: claimed.recipient_set,
      idempotency_key: claimed.idempotency_key,
    });

    // A contact changes between the attempts. The third attempt must not notice.
    await db.db
      .updateTable("contacts")
      .set({ first_name: "Changed" })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "student1@example.org")
      .execute();

    // Attempt 3, after the wait: the same payload with the same key.
    const later = sweepDeps(db, deps.clock.now + 2001);
    await redispatchWaiting(later);
    const again = later.queue.sent.find((item) => item.batchId === pointer.batchId);
    expect(again).toBeDefined();
    deps.mock.respond = undefined;
    deps.clock.now = later.now + 1;
    expect((await processPointer(deps, again)).result).toBe("sent");

    const [first, second, third] = deps.mock.calls;
    expect(second?.body).toBe(first?.body);
    expect(third?.body).toBe(first?.body);
    expect(third?.headers["idempotency-key"]).toBe(claimed.idempotency_key);
    expect(second?.headers["idempotency-key"]).toBe(claimed.idempotency_key);
    // The done batch forgets the set, because it holds personal data.
    expect(await batchRow(db, seeded.workspaceId, pointer.batchId)).toMatchObject({
      status: "done",
      sent_count: 3,
      recipient_set: null,
    });
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });

  it("keeps the set and the key when a quota error pauses the campaign after an unknown attempt", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "resend",
      contacts: 2,
    });
    const pointer = pointers[0] as (typeof pointers)[number];
    const deps = await testDeps(db);
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "internal_server_error" }), { status: 500 });
    expect((await processPointer(deps, pointer)).result).toBe("unknown");
    const claimed = await batchRow(db, seeded.workspaceId, pointer.batchId);
    const sweep = sweepDeps(db, deps.clock.now + LEASE_MS + 1);
    await expireLeases(sweep);
    const retryPointer = sweep.queue.sent.find((item) => item.batchId === pointer.batchId);
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "daily_quota_exceeded", message: "Quota" }), {
        status: 429,
      });
    deps.clock.now = sweep.now + 1;
    expect((await processPointer(deps, retryPointer)).result).toBe("returned");
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("paused");

    const { campaignsResume } = await import("@envelopen/core");
    const queue = recordingQueue();
    await runOperation(
      seeded.principal,
      campaignsResume,
      { id: campaignId },
      { db, services: { sendQueue: queue }, now: () => deps.clock.now + 60_000 },
    );
    deps.mock.respond = undefined;
    deps.clock.now += 60_001;
    const resumed = queue.sent.find((item) => item.batchId === pointer.batchId);
    expect((await processPointer(deps, resumed)).result).toBe("sent");
    const last = deps.mock.calls.at(-1);
    expect(last?.body).toBe(deps.mock.calls[0]?.body);
    expect(last?.headers["idempotency-key"]).toBe(claimed.idempotency_key);
  });

  it("returns the batch to pending after a 429 or a credits error, not to uncertain", async () => {
    const limited = await sendingCampaign({ provider: "resend", contacts: 2 });
    const deps = await testDeps(limited.db);
    deps.mock.respond = () =>
      new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "2" },
      });
    const pointer = limited.pointers[0] as (typeof limited.pointers)[number];
    expect((await processPointer(deps, pointer)).result).toBe("returned");
    expect(await batchRow(limited.db, limited.seeded.workspaceId, pointer.batchId)).toMatchObject({
      status: "pending",
      not_before: deps.clock.now + 2000,
      recipient_set: null,
      idempotency_key: null,
      sent_count: 0,
    });
    expect(deps.backoffs).toEqual([2000]);
    expect(
      (await campaignRow(limited.db, limited.seeded.workspaceId, limited.campaignId)).status,
    ).toBe("sending");

    // The sweep sends it again after the wait, with a fresh claim.
    const sweep = sweepDeps(limited.db, deps.clock.now + 2001);
    await redispatchWaiting(sweep);
    const again = sweep.queue.sent.find((item) => item.batchId === pointer.batchId);
    expect(again?.generation).toBe(pointer.generation + 1);
    deps.mock.respond = undefined;
    deps.clock.now = sweep.now;
    expect((await processPointer(deps, again)).result).toBe("sent");

    const credits = await sendingCampaign({ provider: "postmark", contacts: 2 });
    const creditDeps = await testDeps(credits.db);
    creditDeps.mock.respond = () =>
      new Response(
        JSON.stringify({ ErrorCode: 405, Message: "Your account has run out of credits." }),
        {
          status: 422,
        },
      );
    const creditPointer = credits.pointers[0] as (typeof credits.pointers)[number];
    await processPointer(creditDeps, creditPointer);
    const batch = await batchRow(credits.db, credits.seeded.workspaceId, creditPointer.batchId);
    expect(batch.status).not.toBe("uncertain");
    expect(batch.status).toBe("pending");
    expect(
      await campaignRow(credits.db, credits.seeded.workspaceId, credits.campaignId),
    ).toMatchObject({
      status: "paused",
      pause_reason: "provider_credits",
    });
  });

  it("covers AE2: a hard bounce for a contact in a later batch removes it at send time", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "ses",
      contacts: 30,
    });
    const deps = await testDeps(db);
    expect((await processPointer(deps, pointers[0])).result).toBe("sent");
    // A hard bounce arrives for student28, who is in the second batch.
    const { hashEmail } = await testKeys();
    await db.db
      .insertInto("suppressions")
      .values({
        workspace_id: seeded.workspaceId,
        email_hash: await hashEmail("student28@example.org"),
        reason: "hard_bounce",
        source: "test",
        campaign_id: campaignId,
      })
      .execute();
    expect((await processPointer(deps, pointers[1])).result).toBe("sent");
    expect(deps.mock.delivered).not.toContain("student28@example.org");
    expect(deps.mock.delivered).toHaveLength(29);
    const rows = await recipientRows(db, seeded.workspaceId, campaignId);
    expect(rows.find((row) => row.email === "student28@example.org")).toMatchObject({
      status: "skipped",
      skip_reason: "suppressed",
    });
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });

  it("re-enqueues a batch whose message reached the dead-letter queue, and the campaign completes", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const pointer = pointers[0] as (typeof pointers)[number];
    // The message failed every retry and went to the dead-letter queue: nothing processed it.
    const early = sweepDeps(db, T0 + 10 * 60 * 1000);
    await redispatchWaiting(early);
    expect(early.queue.sent.filter((item) => item.campaignId === campaignId)).toEqual([]);
    const sweep = sweepDeps(db, T0 + 31 * 60 * 1000);
    await redispatchWaiting(sweep);
    const again = sweep.queue.sent.filter((item) => item.campaignId === campaignId);
    expect(again).toEqual([{ ...pointer, generation: pointer.generation + 1 }]);
    const deps = await testDeps(db);
    expect((await processPointer(deps, again[0])).result).toBe("sent");
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });
});

describe("Workers Free limits", () => {
  it("covers AE4: a D1 daily-limit error pauses with platform_limit, shows while every write fails, and resumes after 00:00 UTC", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const pointer = pointers[0] as (typeof pointers)[number];
    const meter = usageMeter(env);
    await meter.clearPlatformLimit();
    const unsubscribes = { ledger: testLedger(), sink: async () => undefined };
    // Every D1 write fails now. The flag goes to the real UsageMeter.
    const limitedDb = dbOver(limitedD1(env.DB));
    const deps = await testDeps(limitedDb, {
      usage: {
        gate: async () => ({ limit: null, unsubscribesPending: false }),
        setPlatformLimit: (since, until) => meter.setPlatformLimit(since, until),
      },
    });
    expect(await processPointer(deps, pointer)).toEqual({
      action: "ack",
      result: "platform_limit",
    });
    expect(deps.mock.calls).toHaveLength(0);
    const flag = (await meter.status()).platformLimit;
    expect(flag?.until).toBe(Date.UTC(2026, 9, 20));

    // The campaign view reads the flag, so it shows the pause without any D1 write.
    const detail = await runOperation(
      seeded.principal,
      campaignsGet,
      { id: campaignId },
      {
        db: limitedDb,
        services: { usage: usageReader(env) },
        now: () => T0 + 2000,
      },
    );
    expect(detail).toMatchObject({
      status: "paused",
      pauseReason: "platform_limit",
      resumeAt: Date.UTC(2026, 9, 20),
    });

    // Before the reset the cron does nothing. After it, the cron resumes and clears the flag.
    const before = sweepDeps(db, T0 + 60_000);
    expect((await runCampaignCron({ db, meter, unsubscribes, sweep: before })).limited).toBe(true);
    expect(before.queue.sent).toEqual([]);
    const after = sweepDeps(db, Date.UTC(2026, 9, 20, 0, 1));
    const report = await runCampaignCron({ db, meter, unsubscribes, sweep: after });
    expect(report.resumed).toContain(campaignId);
    expect((await meter.status()).platformLimit).toBeNull();
    const redispatched = after.queue.sent.find((item) => item.batchId === pointer.batchId);
    expect(redispatched?.generation).toBe(pointer.generation + 1);
    const resumedDeps = await testDeps(db);
    expect((await processPointer(resumedDeps, redispatched)).result).toBe("sent");
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });

  it("covers AE1: a batch that resumes after the reset but before the drain skips a contact with a waiting unsubscribe", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const [first] = await recipientRows(db, seeded.workspaceId, campaignId);
    const ledger = testLedger();
    // The D1 read failed too, so the intent has only the recipient of the token.
    await ledger.record([
      {
        campaignId,
        recipientId: first?.id ?? 0,
        workspaceId: null,
        contactId: null,
        listId: null,
        source: "one_click",
        at: T0,
      },
    ]);
    const deps = await testDeps(db, {
      pendingUnsubscribes: (conn, workspaceId, contactIds) =>
        pendingUnsubscribedContacts(ledger, conn, workspaceId, contactIds),
    });
    deps.ledger.pending = await ledger.pending();
    expect(deps.ledger.pending).toBe(true);
    for (const pointer of pointers) await processPointer(deps, pointer);
    const rows = await recipientRows(db, seeded.workspaceId, campaignId);
    expect(rows.map((row) => [row.status, row.skip_reason])).toEqual([
      ["skipped", "unsubscribed"],
      ["sent", null],
    ]);
    const sentTo = deps.mock.calls.flatMap(
      (item) => JSON.parse(item.body || "[]") as { to: string[] }[],
    );
    expect(sentTo.flatMap((item) => item.to)).toEqual([rows[1]?.email]);
  });

  it("does not ask the ledger while the UsageMeter flag is clear", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const deps = await testDeps(db, {
      pendingUnsubscribes: async () => {
        throw new Error("The ledger was asked.");
      },
    });
    for (const pointer of pointers) await processPointer(deps, pointer);
    const rows = await recipientRows(db, seeded.workspaceId, campaignId);
    expect(rows.map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("the cron keeps platform_limit while unsubscribes wait in the ledger, and lifts it after the drain", async () => {
    const db = campaignDb();
    const ledger = testLedger();
    const meter = env.USAGE_METER.getByName(ledgerMeterName(ledger.name));
    await meter.setPlatformLimit(T0, Date.UTC(2026, 9, 20));
    const intents: IntentInput[] = Array.from({ length: DRAIN_BATCH + 1 }, (_, i) => ({
      campaignId: 1,
      recipientId: 900_000_000 + i,
      workspaceId: null,
      contactId: null,
      listId: null,
      source: "one_click",
      at: T0 + i,
    }));
    await ledger.record(intents);
    const unsubscribes = { ledger, sink: async () => undefined };
    const first = await runCampaignCron({
      db,
      meter,
      unsubscribes,
      sweep: sweepDeps(db, Date.UTC(2026, 9, 20, 0, 1)),
    });
    expect(first.held).toBe(true);
    expect(first.unsubscribes).toEqual({ applied: 0, dropped: DRAIN_BATCH, left: 1 });
    expect(first.resumed).toEqual([]);
    expect((await meter.status()).platformLimit).not.toBeNull();

    const second = await runCampaignCron({
      db,
      meter,
      unsubscribes,
      sweep: sweepDeps(db, Date.UTC(2026, 9, 20, 0, 2)),
    });
    expect(second.held).toBe(false);
    expect(second.unsubscribes).toEqual({ applied: 0, dropped: 1, left: 0 });
    const status = await meter.status();
    expect(status.platformLimit).toBeNull();
    expect(status.unsubscribesPending).toBe(false);
  });

  it("drops a message without a write while the platform_limit flag is set", async () => {
    const { db, pointers } = await sendingCampaign({ contacts: 1 });
    const deps = await testDeps(db);
    deps.limit.value = { since: T0, until: Date.UTC(2026, 9, 20) };
    const writes = db.meter.rowsWritten;
    expect((await processPointer(deps, pointers[0])).result).toBe("platform_limit");
    expect(db.meter.rowsWritten).toBe(writes);
    expect(deps.mock.calls).toHaveLength(0);
  });

  for (const provider of ["ses", "resend", "postmark", "tosend", "cloudflare"]) {
    it(`sends one ${provider} batch in fewer than 50 D1 queries and 50 subrequests`, async () => {
      const adapter = getAdapter(provider);
      if (!adapter) throw new Error(provider);
      const size = adapter.capabilities.batchSize;
      const { seeded, pointers } = await sendingCampaign({ provider, contacts: size });
      expect(pointers).toHaveLength(1);
      const counting = countingD1(env.DB);
      const db = dbOver(counting.d1);
      const deps = await testDeps(db);
      expect((await processPointer(deps, pointers[0])).result).toBe("sent");
      // One more Durable Object call: the usage report at the end of the invocation.
      const objectCalls = deps.objectCalls.count + 1;
      const queries = counting.statements.count;
      const fetches = deps.mock.calls.length;
      expect(deps.mock.delivered).toHaveLength(size);
      expect(queries).toBeLessThan(50);
      expect(queries + fetches + objectCalls).toBeLessThan(50);
      const batch = await batchRow(db, seeded.workspaceId, pointers[0]?.batchId as number);
      expect(batch.sent_count).toBe(size);
    });
  }

  it("makes an SES bulk call above the per-second recipient rate wait for tokens", async () => {
    // 14 recipients per second (the SES account's MaxSendRate), and a batch of 25.
    const { db, seeded, pointers } = await sendingCampaign({
      provider: "ses",
      contacts: 25,
      refs: { maxSendRate: "14" },
    });
    const stub = rateLimiterFor(env, seeded.connectionId);
    const deps = await testDeps(db, {
      rateLimiter: () => ({
        acquire: (units, rule, maxWaitMs) => stub.acquire(units, rule, maxWaitMs, T0),
        backoff: (ms) => stub.backoff(ms, T0),
      }),
    });
    expect((await processPointer(deps, pointers[0])).result).toBe("sent");
    // A full bucket holds 14 tokens. The 11 missing ones take 11/14 of a second.
    expect(deps.sleeps).toEqual([Math.ceil((11 / 14) * 1000)]);
    // A second batch at the same moment waits behind the first.
    const grant = await stub.acquire(25, rateRule(14), MAX_RATE_WAIT_MS, T0);
    expect(grant).toEqual({ granted: true, waitMs: Math.ceil((36 / 14) * 1000) });
    // A wait beyond the limit is not reserved: the message retries later.
    expect(reserve(undefined, 1000, rateRule(14), MAX_RATE_WAIT_MS, T0).grant.granted).toBe(false);
  });
});

describe("snapshot and send-time rules", () => {
  it("does not send to a contact imported after the snapshot", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({ contacts: 2 });
    const { hashEmail } = await testKeys();
    await addContacts(db, hashEmail, seeded.workspaceId, seeded.listId, 1, { prefix: "late" });
    const deps = await testDeps(db);
    for (const pointer of pointers) await processPointer(deps, pointer);
    expect(deps.mock.delivered.sort()).toEqual(["student1@example.org", "student2@example.org"]);
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).recipient_count).toBe(2);
  });

  it("puts links and List-Unsubscribe on the tracking domain only after its check passes", async () => {
    const { campaignsConfirm, campaignsPrepare } = await import("@envelopen/core");
    const { createDraft, seedCampaignWorkspace } = await import(
      "@envelopen/core/testing/campaign-fixtures"
    );
    for (const [trackingStatus, origin] of [
      ["fail", "https://app.envelopen.test"],
      ["unknown", "https://app.envelopen.test"],
      ["pass", "https://links.example.com"],
    ] as const) {
      const db = campaignDb();
      const keys = await testKeys();
      const seeded = await seedCampaignWorkspace(db, keys, { provider: "resend", contacts: 1 });
      await db.db
        .updateTable("sending_domains")
        .set({ tracking_domain: "links.example.com", tracking_status: trackingStatus })
        .where("workspace_id", "=", seeded.workspaceId)
        .where("id", "=", seeded.domainId)
        .execute();
      const campaignId = await createDraft(db, seeded);
      const services = {
        ...keys,
        appOrigin: "https://app.envelopen.test",
        startCampaignJob: async () => {},
      };
      const context = { db, services, now: () => T0 };
      const prepared = await runOperation(
        seeded.principal,
        campaignsPrepare,
        { id: campaignId, mode: "send_now" },
        context,
      );
      expect(prepared.blocked).toBe(false);
      // An unverified tracking domain is a warning, not a block.
      expect(prepared.checklist.find((item) => item.id === "domain_auth")?.status).toBe(
        trackingStatus === "pass" ? "pass" : "warn",
      );
      await runOperation(
        seeded.principal,
        campaignsConfirm,
        { id: campaignId, token: prepared.token as string },
        context,
      );
      expect((await campaignRow(db, seeded.workspaceId, campaignId)).link_origin).toBe(origin);

      const queue = recordingQueue();
      await snapshot(db, { workspaceId: seeded.workspaceId, campaignId, startedAt: T0 }, queue);
      const deps = await testDeps(db);
      expect((await processPointer(deps, queue.sent[0])).result).toBe("sent");
      const [email] = JSON.parse(deps.mock.calls[0]?.body ?? "[]") as {
        html: string;
        headers: Record<string, string>;
      }[];
      expect(email?.headers["List-Unsubscribe"]?.startsWith(`<${origin}/u/`)).toBe(true);
      expect(email?.html).toContain(`${origin}/t/c/`);
      expect(email?.html).not.toContain(
        trackingStatus === "pass" ? "app.envelopen.test" : "links.example.com",
      );
    }
  });

  it("personalizes each recipient with signed one-click unsubscribe headers", async () => {
    const { db, pointers } = await sendingCampaign({ provider: "resend", contacts: 1 });
    const deps = await testDeps(db);
    await processPointer(deps, pointers[0]);
    const [email] = JSON.parse(deps.mock.calls[0]?.body ?? "[]") as {
      subject: string;
      html: string;
      headers: Record<string, string>;
    }[];
    expect(email?.subject).toBe("A new course for Name1");
    expect(email?.html).toContain("Hello Name1");
    expect(email?.html).toContain("https://envelopen.test/t/c/");
    expect(email?.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/envelopen\.test\/u\/[^>]+>$/);
    expect(email?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("records the owner's decision: Skip finishes the campaign, Retry sends again", async () => {
    const { campaignsRetryBatch, campaignsSkipBatch } = await import("@envelopen/core");
    for (const decision of ["skip", "retry"] as const) {
      const { db, seeded, campaignId, pointers } = await sendingCampaign({
        provider: "ses",
        contacts: 2,
      });
      const pointer = pointers[0] as (typeof pointers)[number];
      const deps = await testDeps(db);
      deps.mock.respond = () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      };
      await processPointer(deps, pointer);
      const sweep = sweepDeps(db, deps.clock.now + LEASE_MS + 1);
      await expireLeases(sweep);
      const { finalizeIdle } = await import("@envelopen/core");
      await finalizeIdle(sweep);
      expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("needs_decision");
      const owner = sessionPrincipal({ workspaceId: seeded.workspaceId, userId: seeded.userId });
      if (decision === "skip") {
        expect(
          (await batchRow(db, seeded.workspaceId, pointer.batchId)).recipient_set,
        ).not.toBeNull();
        const result = await runOperation(
          owner,
          campaignsSkipBatch,
          { id: campaignId, batchId: pointer.batchId },
          { db },
        );
        expect(result.campaign.status).toBe("sent");
        // A skipped batch forgets the frozen set, which holds personal data.
        expect((await batchRow(db, seeded.workspaceId, pointer.batchId)).recipient_set).toBeNull();
        continue;
      }
      // Retry needs the explicit acceptance of the duplicate risk.
      await expect(
        runOperation(
          owner,
          campaignsRetryBatch,
          { id: campaignId, batchId: pointer.batchId },
          { db },
        ),
      ).rejects.toThrow(/not valid/);
      const queue = recordingQueue();
      const result = await runOperation(
        owner,
        campaignsRetryBatch,
        { id: campaignId, batchId: pointer.batchId, acceptDuplicateRisk: true },
        { db, services: { sendQueue: queue }, now: () => sweep.now + 1 },
      );
      expect(result.campaign.status).toBe("sending");
      deps.mock.respond = undefined;
      expect((await processPointer(deps, queue.sent[0])).result).toBe("sent");
      expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
    }
  });
});

describe("SMTP connections (U18)", () => {
  it("sends a campaign batch over the socket capability, 20 per batch on Workers Free", async () => {
    const { db, seeded, campaignId, pointers } = await sendingCampaign({
      provider: "smtp",
      contacts: 25,
    });
    expect(pointers).toHaveLength(2);
    const server = mockSmtp();
    const base = await testDeps(db);
    const deps = await testDeps(db, {
      services: { ...base.services, connectSocket: server.connect },
    });
    for (const pointer of pointers)
      expect((await processPointer(deps, pointer)).result).toBe("sent");
    expect(deps.mock.calls).toHaveLength(0);
    // One SMTP connection per batch.
    expect(server.sessions).toHaveLength(2);
    expect(server.messages).toHaveLength(25);
    const mail = parseMail(server.messages[0]?.data ?? "");
    expect(mail.headers.get("list-unsubscribe")).toMatch(/^<https:\/\/.+\/u\/.+>$/);
    expect(mail.headers.get("list-unsubscribe-post")).toBe("List-Unsubscribe=One-Click");
    expect((await campaignRow(db, seeded.workspaceId, campaignId)).status).toBe("sent");
  });

  it("passes the Worker's socket capability to the consumer", async () => {
    const deps = await consumerDeps(env, campaignDb());
    expect(deps.services.connectSocket).toEqual(expect.any(Function));
  });
});
