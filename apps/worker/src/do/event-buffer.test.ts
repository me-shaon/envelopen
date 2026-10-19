import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BufferedEvent,
  DAY_MS,
  flushEvents,
  type ProviderEventRef,
  type TrackingEvent,
} from "@envelopen/core";
import { svixSign } from "@envelopen/providers";
import { resendFixtures } from "@envelopen/providers/conformance/fixtures/resend";
import { describe, expect, it } from "vitest";
import { countingD1, dbOver, testKeys } from "../../test/campaign-helpers";
import { call, LATER, mount, type SentCampaign, sentCampaign } from "../../test/tracking-helpers";
import { RETENTION_MINUTE, runEventCron } from "../cron";
import { createHookRoutes } from "../hooks";
import { PENDING_FLUSH_KEY, type PendingFlush } from "./event-buffer";
import { eventBuffer, eventSink } from "./events";

// The EventBuffer Durable Object (KTD31), the flush, the soft-bounce rule, and the
// cron jobs of the event pipeline. The buffer runs as a real Durable Object on the
// local D1. Each test has its own workspace, so each has its own buffer.

function open(sent: SentCampaign, index: number, at: number, machine = false): TrackingEvent {
  const recipient = sent.recipients[index % sent.recipients.length];
  return {
    source: "tracking",
    type: "open",
    campaignId: sent.campaignId,
    recipientId: recipient?.id ?? 0,
    contactId: recipient?.contact_id ?? null,
    linkId: null,
    machine,
    bot: false,
    reason: null,
    occurredAt: at,
  };
}

async function count(sent: SentCampaign, table: "email_events" | "suppressions") {
  const row = await sent.db.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("workspace_id", "=", sent.seeded.workspaceId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function hourly(sent: SentCampaign) {
  return sent.db.db
    .selectFrom("campaign_stats_hourly")
    .selectAll()
    .where("workspace_id", "=", sent.seeded.workspaceId)
    .where("campaign_id", "=", sent.campaignId)
    .execute();
}

/** A provider message id of the campaign, as the consumer stored it. */
async function messageId(sent: SentCampaign, index = 0): Promise<string> {
  const row = await sent.db.db
    .selectFrom("campaign_recipients")
    .select("provider_message_id")
    .where("workspace_id", "=", sent.seeded.workspaceId)
    .where("id", "=", sent.recipients[index]?.id ?? 0)
    .executeTakeFirstOrThrow();
  return row.provider_message_id as string;
}

/** Stores a provider event as the webhook does, and returns its reference. */
async function providerEvent(
  sent: SentCampaign,
  type: ProviderEventRef["type"],
  occurredAt: number,
  emailHash: string,
  providerMessageId: string | null = null,
): Promise<ProviderEventRef> {
  const row = await sent.db.db
    .insertInto("provider_events")
    .values({
      workspace_id: sent.seeded.workspaceId,
      connection_id: sent.seeded.connectionId,
      provider: "resend",
      event_id: crypto.randomUUID(),
      type,
      provider_message_id: providerMessageId,
      email_hash: emailHash,
      detail: null,
      occurred_at: occurredAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { source: "provider", id: row.id, type, providerMessageId, emailHash, occurredAt };
}

async function hashOf(sent: SentCampaign, index = 0): Promise<string> {
  return (await testKeys()).hashEmail(sent.recipients[index]?.email ?? "");
}

describe("EventBuffer", () => {
  it("flushes at 200 events before the alarm, in fewer than 50 statements", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const buffer = eventBuffer(env, workspaceId);
    const first = Array.from({ length: 199 }, (_, i) =>
      open(sent, i, LATER + i * 1000, i % 3 === 0),
    );
    expect((await buffer.add(workspaceId, first, LATER)).flushed).toBeNull();
    expect(await buffer.size()).toBe(199);
    expect(await count(sent, "email_events")).toBe(0);

    const result = await buffer.add(workspaceId, [open(sent, 199, LATER + 199_000)], LATER);
    expect(result.flushed).toMatchObject({ events: 200, stored: 200 });
    expect(result.flushed?.statements).toBeLessThan(50);
    expect(result.waiting).toBe(0);
    expect(await count(sent, "email_events")).toBe(200);
    const rows = await hourly(sent);
    const total = (key: "opens" | "unique_opens" | "machine_opens") =>
      rows.reduce((sum, row) => sum + row[key], 0);
    expect(total("machine_opens")).toBe(67);
    expect(total("opens")).toBe(133);
    // Two recipients, so two unique human opens.
    expect(total("unique_opens")).toBe(2);
  });

  it("writes one full group of mixed events in fewer than 50 D1 statements", async () => {
    const sent = await sentCampaign();
    const hash = await hashOf(sent);
    const id = await messageId(sent);
    const events: BufferedEvent[] = [];
    for (let i = 0; i < 150; i++) events.push(open(sent, i, LATER + i));
    for (let i = 0; i < 50; i++) {
      events.push(
        await providerEvent(sent, i % 2 ? "delivered" : "bounce_soft", LATER + i, hash, id),
      );
    }
    const { d1, statements } = countingD1(env.DB);
    const result = await flushEvents(dbOver(d1), sent.seeded.workspaceId, events, LATER);
    expect(statements.count).toBe(result.statements);
    expect(statements.count).toBeLessThan(50);
    expect(result.stored).toBe(200);
  });

  it("flushes a partial group when the alarm fires", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const buffer = eventBuffer(env, workspaceId);
    await buffer.add(workspaceId, [open(sent, 0, LATER), open(sent, 1, LATER)], LATER);
    expect(await count(sent, "email_events")).toBe(0);
    expect(await runDurableObjectAlarm(buffer)).toBe(true);
    expect(await count(sent, "email_events")).toBe(2);
    expect(await buffer.size()).toBe(0);
  });

  it("skips a flush id that D1 committed already", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const events = [open(sent, 0, LATER), open(sent, 1, LATER + 1000)];
    const first = await flushEvents(sent.db, workspaceId, events, LATER, { flushId: "group-1" });
    const again = await flushEvents(sent.db, workspaceId, events, LATER, { flushId: "group-1" });
    expect(first).toMatchObject({ stored: 2 });
    expect(again).toMatchObject({ stored: 0, replayed: true });
    expect(await count(sent, "email_events")).toBe(2);
    expect((await hourly(sent)).reduce((sum, row) => sum + row.opens, 0)).toBe(2);
  });

  it("counts a group once when the buffer stops between the D1 commit and the local delete", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const buffer = eventBuffer(env, workspaceId);
    await buffer.add(workspaceId, [open(sent, 0, LATER), open(sent, 1, LATER + 1000)], LATER);

    // The crash: the group has an id, and D1 committed it, but the events are still in
    // storage. This is the state that the buffer leaves when it stops after the commit.
    await runInDurableObject(buffer, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ seq: number; body: string }>("SELECT seq, body FROM events ORDER BY seq")
        .toArray();
      const pending: PendingFlush = { id: crypto.randomUUID(), last: rows.at(-1)?.seq ?? 0 };
      await state.storage.put(PENDING_FLUSH_KEY, pending);
      const events = rows.map((row) => JSON.parse(row.body) as BufferedEvent);
      await flushEvents(sent.db, workspaceId, events, LATER, { flushId: pending.id });
    });
    // A new event arrives before the replay. It is not part of the replayed group.
    await buffer.add(workspaceId, [open(sent, 2, LATER + 2000)], LATER);
    expect(await count(sent, "email_events")).toBe(2);

    await runDurableObjectAlarm(buffer);
    expect(await count(sent, "email_events")).toBe(2);
    expect(await buffer.size()).toBe(1);
    await runDurableObjectAlarm(buffer);
    expect(await count(sent, "email_events")).toBe(3);
    expect(await buffer.size()).toBe(0);
    expect((await hourly(sent)).reduce((sum, row) => sum + row.opens, 0)).toBe(3);
  });

  it("writes a complaint's suppression before the flush, and the flush counts it", async () => {
    const sent = await sentCampaign();
    const { workspaceId, connectionId } = sent.seeded;
    const keys = await testKeys();
    await sent.db.db
      .updateTable("provider_connections")
      .set({
        webhook_secret_encrypted: await keys.credentials.encrypt(resendFixtures.webhookSecret, {
          workspaceId,
          purpose: "webhook_secret",
        }),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", connectionId)
      .execute();
    const body = JSON.stringify({
      type: "email.complained",
      created_at: new Date(LATER).toISOString(),
      data: { email_id: await messageId(sent), to: [sent.recipients[0]?.email] },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const svixId = `msg_${crypto.randomUUID()}`;
    const signature = await svixSign(resendFixtures.webhookSecret, svixId, timestamp, body);
    const hooks = mount(
      "/hooks",
      createHookRoutes({
        createServices: () => ({
          credentials: keys.credentials,
          hashEmail: keys.hashEmail,
          outboundFetch: async () => {
            throw new Error("No outbound request expected.");
          },
          appOrigin: "https://envelopen.test",
        }),
      }),
    );
    const response = await call(hooks, `/hooks/resend/${workspaceId}/${connectionId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body,
    });
    expect(response.status).toBe(200);

    // Before any flush: suppressed, and the event waits in the buffer.
    const suppression = await sent.db.db
      .selectFrom("suppressions")
      .select("reason")
      .where("workspace_id", "=", workspaceId)
      .where("email_hash", "=", await hashOf(sent))
      .executeTakeFirst();
    expect(suppression?.reason).toBe("complaint");
    const buffer = eventBuffer(env, workspaceId);
    expect(await buffer.size()).toBe(1);
    expect(await count(sent, "email_events")).toBe(0);

    await runDurableObjectAlarm(buffer);
    expect((await hourly(sent)).reduce((sum, row) => sum + row.complaints, 0)).toBe(1);
    const stored = await sent.db.db
      .selectFrom("provider_events")
      .select("processed_at")
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(stored.processed_at).not.toBeNull();
  });
});

describe("soft bounces", () => {
  async function bounces(days: number[]) {
    const sent = await sentCampaign();
    const hash = await hashOf(sent);
    for (const day of days) {
      const event = await providerEvent(sent, "bounce_soft", LATER + day * DAY_MS, hash);
      await flushEvents(sent.db, sent.seeded.workspaceId, [event], LATER + day * DAY_MS);
    }
    return sent.db.db
      .selectFrom("suppressions")
      .select(["reason", "source"])
      .where("workspace_id", "=", sent.seeded.workspaceId)
      .where("email_hash", "=", hash)
      .executeTakeFirst();
  }

  it("suppresses the contact on the third soft bounce within 30 days", async () => {
    expect(await bounces([0, 10])).toBeUndefined();
    expect(await bounces([0, 10, 29])).toEqual({
      reason: "soft_bounce_limit",
      source: "soft_bounces",
    });
  });

  it("does not suppress when the first soft bounce is 31 days before the third", async () => {
    expect(await bounces([0, 15, 31])).toBeUndefined();
  });

  it("counts a replayed soft bounce once", async () => {
    const sent = await sentCampaign();
    const hash = await hashOf(sent);
    const first = await providerEvent(sent, "bounce_soft", LATER, hash);
    const second = await providerEvent(sent, "bounce_soft", LATER + DAY_MS, hash);
    // The same two events reach the flush twice (a rescue after a slow hand-off).
    await flushEvents(sent.db, sent.seeded.workspaceId, [first, second], LATER + DAY_MS);
    await flushEvents(sent.db, sent.seeded.workspaceId, [first, second], LATER + DAY_MS);
    expect(await count(sent, "suppressions")).toBe(0);
  });
});

describe("event cron jobs", () => {
  it("deletes raw events older than the retention period and keeps the rollups", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    await sent.db.db
      .updateTable("workspaces")
      .set({ event_retention_days: 30 })
      .where("id", "=", workspaceId)
      .execute();
    await flushEvents(
      sent.db,
      workspaceId,
      [open(sent, 0, LATER), open(sent, 1, LATER + 1000)],
      LATER,
    );
    await flushEvents(sent.db, workspaceId, [open(sent, 0, LATER + 20 * DAY_MS)], LATER);
    const before = await hourly(sent);

    const hour = new Date(LATER + 31 * DAY_MS);
    hour.setUTCMinutes(RETENTION_MINUTE + 1);
    // Outside the retention minute, nothing is deleted.
    let report = await runEventCron(sent.db, eventSink(env), hour.getTime());
    expect(report.retention).toBeNull();
    hour.setUTCMinutes(RETENTION_MINUTE);
    report = await runEventCron(sent.db, eventSink(env), hour.getTime());
    expect(report.retention?.emailEvents).toBeGreaterThanOrEqual(2);
    expect(await count(sent, "email_events")).toBe(1);
    expect(await hourly(sent)).toEqual(before);
  });

  it("hands provider events that no flush applied to the buffer again", async () => {
    const sent = await sentCampaign();
    const { workspaceId } = sent.seeded;
    const event = await providerEvent(
      sent,
      "delivered",
      LATER,
      await hashOf(sent),
      await messageId(sent),
    );
    const received: { workspaceId: number; events: BufferedEvent[] }[] = [];
    const report = await runEventCron(
      sent.db,
      async (id, events) => {
        received.push({ workspaceId: id, events });
      },
      Date.now() + 10 * 60 * 1000,
    );
    expect(report.rescued).toBeGreaterThanOrEqual(1);
    const mine = received.find((entry) => entry.workspaceId === workspaceId);
    expect(mine?.events).toEqual([event]);
  });
});
