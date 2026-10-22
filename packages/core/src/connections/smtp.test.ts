import type { DbConnection } from "@envelopen/db";
import { GMAIL_POLICY_WARNING } from "@envelopen/providers";
import {
  brevoEvent,
  brevoFixtures,
  brevoRequest,
} from "@envelopen/providers/conformance/fixtures/smtp";
import { mockSmtp } from "@envelopen/providers/conformance/mock-smtp";
import { describe, expect, it } from "vitest";
import {
  createOwnedWorkspace,
  createUser,
  insertContact,
  testDb,
  testServices,
} from "../../test/fixtures";
import { runOperation } from "../executor";
import { sessionPrincipal } from "../principal";
import {
  connectionsAcceptPolicy,
  connectionsCreate,
  connectionsGet,
  connectionsRotateWebhookSecret,
} from "./operations";
import { assertCampaignPolicy, checkCampaignPolicy } from "./policy-gate";
import { receiveProviderWebhook } from "./webhooks";

// SMTP connections with presets (U18): the Gmail policy warning (R29), the daily cap,
// and the Brevo webhook receiver with its bearer token (KTD13).

async function owner() {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, "SMTP");
  return { db, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

type Owner = Awaited<ReturnType<typeof owner>>;

async function connectSmtp(
  { db, principal }: Owner,
  credentials: Record<string, string>,
  server = { username: credentials.username ?? "", password: credentials.password ?? "" },
  extra: { dailyCap?: number | null } = {},
) {
  const smtp = mockSmtp(server);
  const services = await testServices({ connect: smtp.connect });
  const connection = await runOperation(
    principal,
    connectionsCreate,
    { provider: "smtp", credentials, ...extra },
    { db, services },
  );
  return { connection, services, smtp };
}

const GMAIL = { preset: "gmail", username: "ana@gmail.com", password: "abcdefghijklmnop" };

function hook(workspaceId: number, connectionId: number) {
  return { provider: "smtp", workspaceId, connectionId };
}

function hookUrl(workspaceId: number, connectionId: number) {
  return `https://envelopen.test/hooks/smtp/${workspaceId}/${connectionId}`;
}

async function contactWithList(db: DbConnection, workspaceId: number, email: string) {
  const services = await testServices();
  const { id } = await insertContact(db, workspaceId, { email });
  await db.db
    .updateTable("contacts")
    .set({ email_hash: await services.hashEmail(email) })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .execute();
  const list = await db.db
    .insertInto("lists")
    .values({ workspace_id: workspaceId, name: "News", description: null })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.db
    .insertInto("list_members")
    .values({
      workspace_id: workspaceId,
      list_id: list.id,
      contact_id: id,
      status: "subscribed",
      status_source: "test",
      status_at: Date.now(),
      status_campaign_id: null,
    })
    .execute();
  return id;
}

describe("SMTP connections", () => {
  it("connects Gmail with the preset's cap and no webhook", async () => {
    const ctx = await owner();
    const { connection, smtp } = await connectSmtp(ctx, GMAIL);
    expect(connection).toMatchObject({
      provider: "smtp",
      name: "Gmail",
      preset: "gmail",
      dailyCap: 500,
      eventsSetup: "none",
      policyWarning: GMAIL_POLICY_WARNING,
      policyWarningAcceptedAt: null,
      warnings: [expect.stringContaining("no bounce or complaint events")],
      webhook: { url: null, secret: null, secretSource: "none" },
    });
    expect(smtp.sessions[0]?.target.hostname).toBe("smtp.gmail.com");
    expect(smtp.messages).toHaveLength(0);
  });

  it("keeps the cap that the owner sets", async () => {
    const ctx = await owner();
    const { connection } = await connectSmtp(ctx, { ...GMAIL }, undefined, { dailyCap: 150 });
    expect(connection.dailyCap).toBe(150);
  });

  it("refuses a wrong app password and stores nothing", async () => {
    const ctx = await owner();
    await expect(
      connectSmtp(ctx, GMAIL, { username: GMAIL.username, password: "another" }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { reason: "auth" } });
    const rows = await ctx.db.db
      .selectFrom("provider_connections")
      .select("id")
      .where("workspace_id", "=", ctx.workspaceId)
      .execute();
    expect(rows).toEqual([]);
  });

  it("needs the policy acceptance before the first campaign through a Gmail connection", async () => {
    const ctx = await owner();
    const { connection, services } = await connectSmtp(ctx, GMAIL);
    const policy = await checkCampaignPolicy(ctx.db, ctx.workspaceId);
    expect(policy).toMatchObject({
      allowed: false,
      code: "policy_warning",
      warning: GMAIL_POLICY_WARNING,
      connectionId: connection.id,
    });
    expect(policy.allowed === false && policy.message).toContain("sending policy warning");
    await expect(assertCampaignPolicy(ctx.db, ctx.workspaceId)).rejects.toMatchObject({
      code: "conflict",
      details: { code: "policy_warning" },
    });

    const accepted = await runOperation(
      ctx.principal,
      connectionsAcceptPolicy,
      { id: connection.id, accept: true },
      { db: ctx.db, services },
    );
    expect(accepted.policyWarningAcceptedAt).toEqual(expect.any(Number));
    expect(await checkCampaignPolicy(ctx.db, ctx.workspaceId)).toEqual({
      allowed: true,
      connectionId: connection.id,
      provider: "smtp",
    });
  });

  it("lets campaigns through a Brevo or custom connection without a warning", async () => {
    const ctx = await owner();
    const { connection } = await connectSmtp(ctx, brevoFixtures.credentials);
    expect(connection.policyWarning).toBeNull();
    expect((await checkCampaignPolicy(ctx.db, ctx.workspaceId)).allowed).toBe(true);
    await expect(
      runOperation(
        ctx.principal,
        connectionsAcceptPolicy,
        { id: connection.id, accept: true },
        { db: ctx.db, services: await testServices() },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("Brevo webhooks", () => {
  async function connectBrevo() {
    const ctx = await owner();
    const result = await connectSmtp(ctx, brevoFixtures.credentials);
    const token = result.connection.webhook.secret ?? "";
    return { ...ctx, ...result, token };
  }

  it("generates a bearer token at connect and keeps it out of the URL", async () => {
    const { connection, token, workspaceId, db } = await connectBrevo();
    expect(connection).toMatchObject({
      preset: "brevo",
      dailyCap: 300,
      eventsSetup: "manual",
      webhook: {
        url: hookUrl(workspaceId, connection.id),
        secretSource: "envelopen",
      },
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(connection.webhook.url).not.toContain(token);
    expect(connection.webhook.steps.join("\n")).toContain('"type":"bearer"');
    const row = await db.db
      .selectFrom("provider_connections")
      .select("webhook_secret_encrypted")
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(row.webhook_secret_encrypted).toMatch(/^v2\./);
    expect(row.webhook_secret_encrypted).not.toContain(token);
  });

  it("rejects a webhook with a wrong bearer token and records nothing", async () => {
    const { connection, token, workspaceId, db, services } = await connectBrevo();
    const url = hookUrl(workspaceId, connection.id);
    const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const wrong of [changed, "", "short"]) {
      const outcome = await receiveProviderWebhook(
        { db, services },
        hook(workspaceId, connection.id),
        brevoRequest(brevoEvent("hard_bounce"), wrong, url),
      );
      expect(outcome).toMatchObject({ status: 401, stored: 0 });
    }
    // The token in the URL instead of the header does not pass either.
    const inUrl = await receiveProviderWebhook(
      { db, services },
      hook(workspaceId, connection.id),
      brevoRequest(brevoEvent("hard_bounce"), "", `${url}?token=${token}`),
    );
    expect(inUrl.status).toBe(401);
    expect(
      await db.db
        .selectFrom("provider_events")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .execute(),
    ).toEqual([]);
    expect(
      await db.db
        .selectFrom("suppressions")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .execute(),
    ).toEqual([]);
  });

  it("suppresses the address of a hard bounce", async () => {
    const { connection, token, workspaceId, db, services } = await connectBrevo();
    const outcome = await receiveProviderWebhook(
      { db, services },
      hook(workspaceId, connection.id),
      brevoRequest(
        brevoEvent("hard_bounce", { email: "Gone@Example.org", reason: "550 No such user" }),
        token,
        hookUrl(workspaceId, connection.id),
      ),
    );
    expect(outcome).toMatchObject({ status: 200, received: 1, stored: 1 });
    const suppression = await db.db
      .selectFrom("suppressions")
      .select(["email_hash", "reason", "source"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(suppression).toEqual({
      email_hash: await services.hashEmail("gone@example.org"),
      reason: "hard_bounce",
      source: "provider:smtp",
    });
    const event = await db.db
      .selectFrom("provider_events")
      .select(["type", "detail", "provider_message_id"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      type: "bounce_hard",
      detail: "hard_bounce: 550 No such user",
      provider_message_id: "<0123456789abcdef0123456789abcdef@mail.example.com>",
    });
  });

  it("unsubscribes the contact of an unsubscribe event from every list", async () => {
    const { connection, token, workspaceId, db, services } = await connectBrevo();
    const contactId = await contactWithList(db, workspaceId, "student1@example.org");
    const request = () =>
      brevoRequest(brevoEvent("unsubscribed"), token, hookUrl(workspaceId, connection.id));
    const outcome = await receiveProviderWebhook(
      { db, services },
      hook(workspaceId, connection.id),
      request(),
    );
    expect(outcome).toMatchObject({ status: 200, received: 1, stored: 0 });
    const contact = await db.db
      .selectFrom("contacts")
      .select(["unsubscribed_at", "unsubscribe_source"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", contactId)
      .executeTakeFirstOrThrow();
    expect(contact).toEqual({
      unsubscribed_at: expect.any(Number),
      unsubscribe_source: "provider:smtp",
    });
    const member = await db.db
      .selectFrom("list_members")
      .select(["status", "status_source"])
      .where("workspace_id", "=", workspaceId)
      .where("contact_id", "=", contactId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ status: "unsubscribed", status_source: "provider:smtp" });
    expect(services.welcomeStops.map((job) => job.contactId)).toEqual([]);

    // A replay keeps the first unsubscribe time.
    await receiveProviderWebhook({ db, services }, hook(workspaceId, connection.id), request());
    const again = await db.db
      .selectFrom("contacts")
      .select("unsubscribed_at")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", contactId)
      .executeTakeFirstOrThrow();
    expect(again.unsubscribed_at).toBe(contact.unsubscribed_at);
  });

  it("answers 429 and records nothing when the connection is over its cap", async () => {
    const { connection, token, workspaceId, db, services } = await connectBrevo();
    const outcome = await receiveProviderWebhook(
      { db, services, admit: async () => false },
      hook(workspaceId, connection.id),
      brevoRequest(brevoEvent("spam"), token, hookUrl(workspaceId, connection.id)),
    );
    expect(outcome).toMatchObject({ status: 429, stored: 0 });
    expect(
      await db.db
        .selectFrom("suppressions")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .execute(),
    ).toEqual([]);
  });

  it("rotates the token: the old token stops working, the new one works", async () => {
    const { connection, token, workspaceId, db, services, principal } = await connectBrevo();
    const rotated = await runOperation(
      principal,
      connectionsRotateWebhookSecret,
      { id: connection.id },
      { db, services },
    );
    const fresh = rotated.webhook.secret ?? "";
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(fresh).not.toBe(token);
    const url = hookUrl(workspaceId, connection.id);
    const old = await receiveProviderWebhook(
      { db, services },
      hook(workspaceId, connection.id),
      brevoRequest(brevoEvent("spam"), token, url),
    );
    expect(old.status).toBe(401);
    const now = await receiveProviderWebhook(
      { db, services },
      hook(workspaceId, connection.id),
      brevoRequest(brevoEvent("spam"), fresh, url),
    );
    expect(now).toMatchObject({ status: 200, stored: 1 });
    const detail = await runOperation(
      principal,
      connectionsGet,
      { id: connection.id },
      { db, services },
    );
    expect(detail.webhook.secret).toBe(fresh);
  });

  it("has no token to rotate on a Gmail connection", async () => {
    const ctx = await owner();
    const { connection, services } = await connectSmtp(ctx, GMAIL);
    await expect(
      runOperation(
        ctx.principal,
        connectionsRotateWebhookSecret,
        { id: connection.id },
        { db: ctx.db, services },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // A webhook to a Gmail connection never verifies.
    const outcome = await receiveProviderWebhook(
      { db: ctx.db, services },
      hook(ctx.workspaceId, connection.id),
      brevoRequest(brevoEvent("spam"), "anything", hookUrl(ctx.workspaceId, connection.id)),
    );
    expect(outcome.status).toBe(401);
  });
});
