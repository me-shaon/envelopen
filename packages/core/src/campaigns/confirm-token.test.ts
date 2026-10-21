import { describe, expect, it } from "vitest";
import { addContacts, createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { createApiKey, testDb, testServices } from "../../test/fixtures";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { apiKeyPrincipal, type Principal } from "../principal";
import {
  campaignsConfirm,
  campaignsPrepare,
  campaignsUnschedule,
  campaignsUpdate,
} from "./operations";
import { startDueCampaigns } from "./sweep";

// Prepare and confirm (R68): the token is bound to the actor, the campaign version,
// the mode, and a short time, and it works once.

const T0 = Date.UTC(2026, 9, 19, 12);

async function setup() {
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, { contacts: 3 });
  const campaignId = await createDraft(db, seeded);
  const run = <T>(
    principal: Principal,
    op: Parameters<typeof runOperation>[1],
    input: unknown,
    now = T0,
  ) => runOperation(principal, op, input, { db, services, now: () => now }) as Promise<T>;
  const prepare = (principal: Principal = seeded.principal, now = T0) =>
    run<{ token: string | null; blocked: boolean; estimate: { recipients: number } }>(
      principal,
      campaignsPrepare,
      { id: campaignId, mode: "send_now" },
      now,
    );
  const confirm = (token: string, principal: Principal = seeded.principal, now = T0 + 1000) =>
    run<{ status: string }>(principal, campaignsConfirm, { id: campaignId, token }, now);
  return { db, services, seeded, campaignId, run, prepare, confirm };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOperationError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

describe("confirm token", () => {
  it("starts the send once, with a job for the snapshot", async () => {
    const { prepare, confirm, services, campaignId } = await setup();
    const prepared = await prepare();
    expect(prepared.blocked).toBe(false);
    expect(prepared.estimate.recipients).toBe(3);
    const token = prepared.token as string;
    expect(await confirm(token)).toMatchObject({ status: "sending" });
    expect(services.campaignJobs).toEqual([
      expect.objectContaining({ campaignId, startedAt: T0 + 1000 }),
    ]);
    // Second use.
    expect(await failure(confirm(token))).toMatchObject({
      code: "conflict",
      details: { reason: "used" },
    });
  });

  it("stores the tracking of the send from the campaign and workspace switches", async () => {
    const { db, seeded, campaignId, prepare, confirm } = await setup();
    await db.db
      .updateTable("workspaces")
      .set({ tracking_opens: 0, tracking_clicks: 1 })
      .where("id", "=", seeded.workspaceId)
      .execute();
    await confirm((await prepare()).token as string);
    const row = await db.db
      .selectFrom("campaigns")
      .select(["send_tracking_opens", "send_tracking_clicks"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", campaignId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ send_tracking_opens: 0, send_tracking_clicks: 1 });
  });

  it("fails after the campaign is edited", async () => {
    const { prepare, confirm, run, seeded, campaignId } = await setup();
    const token = (await prepare()).token as string;
    await run(seeded.principal, campaignsUpdate, { id: campaignId, subject: "Changed" });
    expect(await failure(confirm(token))).toMatchObject({
      code: "conflict",
      details: { reason: "stale" },
    });
  });

  it("fails after its TTL", async () => {
    const { prepare, confirm, seeded } = await setup();
    const token = (await prepare()).token as string;
    expect(await failure(confirm(token, seeded.principal, T0 + 16 * 60 * 1000))).toMatchObject({
      code: "conflict",
      details: { reason: "expired" },
    });
  });

  it("fails for another actor", async () => {
    const { db, prepare, confirm, seeded } = await setup();
    const token = (await prepare()).token as string;
    const key = await createApiKey(db, seeded.workspaceId, ["campaigns:send"]);
    const agent = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: key.id,
      scopes: ["campaigns:send"],
      surface: "rest",
    });
    expect(await failure(confirm(token, agent))).toMatchObject({
      code: "forbidden",
      details: { reason: "actor" },
    });
    // The owner can still use it.
    expect(await confirm(token)).toMatchObject({ status: "sending" });
  });

  it("stays valid when new contacts join the targeted list between prepare and confirm", async () => {
    const { db, services, prepare, confirm, seeded } = await setup();
    const prepared = await prepare();
    await addContacts(db, services.hashEmail, seeded.workspaceId, seeded.listId, 2, {
      prefix: "late",
    });
    expect(await confirm(prepared.token as string)).toMatchObject({ status: "sending" });
  });

  it("issues no token when a check fails", async () => {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services, {
      contacts: 1,
      unverifiedDomain: true,
    });
    const id = await createDraft(db, seeded);
    const prepared = (await runOperation(
      seeded.principal,
      campaignsPrepare,
      { id, mode: "send_now" },
      { db, services, now: () => T0 },
    )) as { token: string | null; blocked: boolean };
    expect(prepared).toMatchObject({ blocked: true, token: null });
  });

  it("schedules with the time bound to the token", async () => {
    const { run, seeded, campaignId, services } = await setup();
    const at = T0 + 60 * 60 * 1000;
    const prepared = await run<{ token: string }>(seeded.principal, campaignsPrepare, {
      id: campaignId,
      mode: "schedule",
      scheduledAt: at,
    });
    const row = await run<{ status: string; scheduledAt: number }>(
      seeded.principal,
      campaignsConfirm,
      {
        id: campaignId,
        token: prepared.token,
      },
    );
    expect(row).toMatchObject({ status: "scheduled", scheduledAt: at });
    expect(services.campaignJobs).toEqual([]);

    // The cron starts it at the time, not before.
    const sweep = (now: number) => ({
      db: testDb(),
      queue: services.sendQueue,
      startCampaignJob: services.startCampaignJob,
      now,
    });
    expect(await startDueCampaigns(sweep(at - 1))).not.toContain(campaignId);
    expect(await startDueCampaigns(sweep(at))).toContain(campaignId);
    expect(services.campaignJobs).toEqual([
      { workspaceId: seeded.workspaceId, campaignId, startedAt: at },
    ]);
  });

  it("stores the timezone and the wall-clock time of a schedule (R8)", async () => {
    const { run, seeded, campaignId } = await setup();
    // 09:00 on 2026-10-21 in Asia/Dhaka (UTC+6) is 03:00 UTC.
    const at = Date.UTC(2026, 9, 21, 3);
    const prepared = await run<{ token: string; timezone: string; scheduledLocalTime: string }>(
      seeded.principal,
      campaignsPrepare,
      { id: campaignId, mode: "schedule", scheduledAt: at, timezone: "Asia/Dhaka" },
    );
    expect(prepared).toMatchObject({
      timezone: "Asia/Dhaka",
      scheduledLocalTime: "2026-10-21T09:00+06:00",
    });
    const row = await run<Record<string, unknown>>(seeded.principal, campaignsConfirm, {
      id: campaignId,
      token: prepared.token,
    });
    expect(row).toMatchObject({
      status: "scheduled",
      scheduledAt: at,
      scheduledTimezone: "Asia/Dhaka",
      scheduledLocalTime: "2026-10-21T09:00+06:00",
    });

    // Unschedule clears the zone with the time.
    expect(await run(seeded.principal, campaignsUnschedule, { id: campaignId })).toMatchObject({
      status: "draft",
      scheduledAt: null,
      scheduledTimezone: null,
      scheduledLocalTime: null,
    });
  });

  it("keeps the offset that tells a fall-back hour apart", async () => {
    const { run, seeded, campaignId } = await setup();
    // 01:30 EDT on 2026-11-01, the first of the two 01:30s in America/New_York.
    const at = Date.UTC(2026, 10, 1, 5, 30);
    const prepared = await run<{ scheduledLocalTime: string }>(seeded.principal, campaignsPrepare, {
      id: campaignId,
      mode: "schedule",
      scheduledAt: at,
      timezone: "America/New_York",
    });
    expect(prepared.scheduledLocalTime).toBe("2026-11-01T01:30-04:00");
  });

  it("keeps the UTC-only schedule for an API or MCP caller that gives no timezone", async () => {
    const { db, run, seeded, campaignId } = await setup();
    const key = await createApiKey(db, seeded.workspaceId, ["campaigns:send"]);
    const agent = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: key.id,
      scopes: ["campaigns:send"],
      surface: "mcp",
    });
    const at = T0 + 60 * 60 * 1000;
    const prepared = await run<{ token: string; timezone: string | null }>(
      agent,
      campaignsPrepare,
      { id: campaignId, mode: "schedule", scheduledAt: at },
    );
    expect(prepared).toMatchObject({ timezone: null, scheduledLocalTime: null });
    expect(
      await run(agent, campaignsConfirm, { id: campaignId, token: prepared.token }),
    ).toMatchObject({
      status: "scheduled",
      scheduledAt: at,
      scheduledTimezone: null,
      scheduledLocalTime: null,
    });
  });

  it("rejects a timezone that is not a known IANA zone", async () => {
    const { run, seeded, campaignId } = await setup();
    const at = T0 + 60 * 60 * 1000;
    for (const timezone of ["Mars/Olympus_Mons", "+06:00", "Asia/Dhaka; drop"]) {
      expect(
        await failure(
          run(seeded.principal, campaignsPrepare, {
            id: campaignId,
            mode: "schedule",
            scheduledAt: at,
            timezone,
          }),
        ),
      ).toMatchObject({ code: "invalid_input" });
    }
  });
});
