import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { flushEvents } from "../events/flush";
import type { BufferedEvent, TrackingEvent } from "../events/model";
import { aggregateRollups, countersOf, HOUR_MS, rollupQueries, utcDayOf } from "./rollups";

// Rollups (KTD32): the counters each event adds, and the flush that writes the hourly,
// daily, and workspace daily rows on D1.

const T = Date.UTC(2026, 9, 19, 12, 30);

describe("countersOf", () => {
  it("keeps machine opens and bot clicks apart from the human counts", () => {
    const base = { campaignId: 1, machine: false, bot: false, unique: false, occurredAt: T };
    expect(countersOf({ ...base, type: "open", unique: true })).toEqual({
      opens: 1,
      unique_opens: 1,
    });
    expect(countersOf({ ...base, type: "open", machine: true, unique: true })).toEqual({
      machine_opens: 1,
    });
    expect(countersOf({ ...base, type: "click", bot: true })).toEqual({ bot_clicks: 1 });
    expect(countersOf({ ...base, type: "bounce_soft" })).toEqual({ bounces_soft: 1 });
    expect(countersOf({ ...base, type: "failed" })).toEqual({});
  });

  it("sums events by campaign and hour, by campaign and day, and by day", () => {
    const base = { campaignId: 1, machine: false, bot: false, unique: false };
    const rollups = aggregateRollups([
      { ...base, type: "delivered", occurredAt: T },
      { ...base, type: "delivered", occurredAt: T + HOUR_MS },
      { ...base, campaignId: 2, type: "complaint", occurredAt: T },
    ]);
    expect(rollups.hourly.size).toBe(3);
    expect(rollups.daily.get(`1|${utcDayOf(T)}`)?.counts).toEqual({ delivered: 2 });
    expect(rollups.workspace.get(utcDayOf(T))?.counts).toEqual({ delivered: 2, complaints: 1 });
  });
});

describe("the flush", () => {
  it("updates the hourly and daily rollups, and adds to the sent counts", async () => {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services, { contacts: 2 });
    const { workspaceId } = seeded;
    const campaignId = await createDraft(db, seeded);
    const contacts = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute();
    const recipients = await db.db
      .insertInto("campaign_recipients")
      .values(
        contacts.map((contact, index) => ({
          workspace_id: workspaceId,
          campaign_id: campaignId,
          batch_id: null,
          contact_id: contact.id,
          status: "sent" as const,
          skip_reason: null,
          provider_message_id: `m-${index}`,
          error: null,
          sent_at: T - HOUR_MS,
          opened_at: null,
          clicked_at: null,
        })),
      )
      .returning(["id", "contact_id"])
      .execute();
    // The consumer's `sent` count is already in the rollups (campaigns/batch.ts).
    const hour = Math.floor(T / HOUR_MS) * HOUR_MS;
    await sql`INSERT INTO campaign_stats_hourly (workspace_id, campaign_id, hour, sent) VALUES (${workspaceId}, ${campaignId}, ${hour}, 2)`.execute(
      db.db,
    );

    const open = (index: number, at: number, machine = false): TrackingEvent => ({
      source: "tracking",
      type: "open",
      campaignId,
      recipientId: recipients[index]?.id ?? 0,
      contactId: recipients[index]?.contact_id ?? null,
      linkId: null,
      machine,
      bot: false,
      reason: null,
      occurredAt: at,
    });
    const delivered = await db.db
      .insertInto("provider_events")
      .values({
        workspace_id: workspaceId,
        connection_id: seeded.connectionId,
        provider: "resend",
        event_id: "delivered-1",
        type: "delivered",
        provider_message_id: "m-0",
        email_hash: null,
        detail: null,
        occurred_at: T,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const events: BufferedEvent[] = [
      open(0, T, true),
      open(0, T + 1000),
      open(0, T + 2000),
      open(1, T + HOUR_MS),
      {
        source: "provider",
        id: delivered.id,
        type: "delivered",
        providerMessageId: "m-0",
        emailHash: null,
        occurredAt: T,
      },
    ];
    await flushEvents(db, workspaceId, events, T + 2 * HOUR_MS);

    const hourly = await db.db
      .selectFrom("campaign_stats_hourly")
      .select(["hour", "sent", "delivered", "opens", "unique_opens", "machine_opens"])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .orderBy("hour")
      .execute();
    expect(hourly).toEqual([
      { hour, sent: 2, delivered: 1, opens: 2, unique_opens: 1, machine_opens: 1 },
      { hour: hour + HOUR_MS, sent: 0, delivered: 0, opens: 1, unique_opens: 1, machine_opens: 0 },
    ]);
    const daily = await db.db
      .selectFrom("campaign_stats_daily")
      .select(["day", "delivered", "opens", "unique_opens", "machine_opens"])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .execute();
    expect(daily).toEqual([
      { day: utcDayOf(T), delivered: 1, opens: 3, unique_opens: 2, machine_opens: 1 },
    ]);
    const workspace = await db.db
      .selectFrom("workspace_stats_daily")
      .select(["opens", "unique_opens", "delivered"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(workspace).toEqual({ opens: 3, unique_opens: 2, delivered: 1 });

    // The first human open is on the recipient, for unique counts and follow-ups.
    const first = await db.db
      .selectFrom("campaign_recipients")
      .select("opened_at")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", recipients[0]?.id ?? 0)
      .executeTakeFirstOrThrow();
    expect(first.opened_at).toBe(T + 1000);

    // A later flush does not count the recipient's open as unique again.
    await flushEvents(db, workspaceId, [open(0, T + 3 * HOUR_MS)], T + 3 * HOUR_MS);
    const totals = await db.db
      .selectFrom("campaign_stats_daily")
      .select(["opens", "unique_opens"])
      .where("workspace_id", "=", workspaceId)
      .where("campaign_id", "=", campaignId)
      .executeTakeFirstOrThrow();
    expect(totals).toEqual({ opens: 4, unique_opens: 2 });
  });

  it("builds at most three statements for any number of rows", () => {
    const db = testDb();
    const base = { campaignId: 1, machine: false, bot: false, unique: true, type: "open" as const };
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...base,
      campaignId: i,
      occurredAt: T + i * HOUR_MS,
    }));
    expect(rollupQueries(db.db, 1, aggregateRollups(many))).toHaveLength(3);
  });
});
