import type { DbConnection } from "@envelopen/db";
import { resendFixtures } from "@envelopen/providers/conformance/fixtures/resend";
import { toSendFixtures } from "@envelopen/providers/conformance/fixtures/tosend";
import { mockFetch, type RecordedExchange } from "@envelopen/providers/conformance/mock-fetch";
import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../principal";
import { onboardingStatus, TEST_SEND_ACTION } from "../registry/operations/onboarding";
import { connectionsAcceptPolicy, connectionsCreate, connectionsSelect } from "./operations";
import { assertCampaignPolicy, checkCampaignPolicy } from "./policy-gate";
import { sendSystemEmail } from "./send";
import {
  campaignsSendTest,
  testAddressesAdd,
  testAddressesList,
  testAddressesRemove,
} from "./test-send";

const TOSEND_BATCH_OK = {
  label: "toSend batch accepted",
  method: "POST",
  url: "https://api.tosend.com/v2/emails/batch",
  response: { status: 200, body: { results: [{ status: "success", message_id: "ts-1" }] } },
};

async function owner() {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, "Gate");
  return { db, userId, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

async function connect(
  db: DbConnection,
  principal: Principal,
  provider: "tosend" | "resend",
  exchanges: RecordedExchange[],
) {
  const mock = mockFetch(exchanges);
  const services = await testServices({ fetch: mock.fetch });
  const credentials =
    provider === "tosend" ? toSendFixtures.credentials : { apiKey: "re_live_key123" };
  const connection = await runOperation(
    principal,
    connectionsCreate,
    { provider, credentials },
    { db, services },
  );
  return { connection, services, mock };
}

async function verifiedDomain(db: DbConnection, workspaceId: number, domain = "mail.example.com") {
  await db.db
    .insertInto("sending_domains")
    .values({
      workspace_id: workspaceId,
      connection_id: null,
      domain,
      tracking_domain: null,
      last_checked_at: Date.now(),
      verified_at: Date.now(),
    })
    .execute();
}

async function auditActions(db: DbConnection, workspaceId: number) {
  const rows = await db.db
    .selectFrom("audit_log")
    .select(["action", "metadata", "actor_id"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("id", "asc")
    .execute();
  return rows;
}

describe("provider policy gate (R62, AE8)", () => {
  it("blocks a campaign without a connection", async () => {
    const { db, workspaceId } = await owner();
    expect(await checkCampaignPolicy(db, workspaceId)).toMatchObject({
      allowed: false,
      code: "no_connection",
    });
  });

  it("blocks a campaign prepare with only a toSend connection, and shows the warning", async () => {
    const { db, workspaceId, principal } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    const policy = await checkCampaignPolicy(db, workspaceId);
    expect(policy).toMatchObject({ allowed: false, code: "policy_warning" });
    expect(policy.allowed === false && policy.warning).toContain("transactional provider");
    await expect(assertCampaignPolicy(db, workspaceId)).rejects.toMatchObject({
      code: "conflict",
      details: { code: "policy_warning" },
    });
  });

  it("passes after the owner accepts the warning, and the audit log records it", async () => {
    const { db, workspaceId, principal, userId } = await owner();
    const { connection, services } = await connect(db, principal, "tosend", [toSendFixtures.info]);
    const accepted = await runOperation(
      principal,
      connectionsAcceptPolicy,
      { id: connection.id, accept: true },
      { db, services },
    );
    expect(accepted.policyWarningAcceptedAt).toEqual(expect.any(Number));
    expect(await checkCampaignPolicy(db, workspaceId)).toEqual({
      allowed: true,
      connectionId: connection.id,
      provider: "tosend",
    });
    const audit = (await auditActions(db, workspaceId)).find(
      (row) => row.action === "connections.accept_policy",
    );
    expect(audit?.actor_id).toBe(userId);
    expect(JSON.parse(audit?.metadata ?? "{}")).toMatchObject({ provider: "tosend" });
  });

  it("needs an explicit accept, the owner's session, and a transactional-only connection", async () => {
    const { db, workspaceId, principal } = await owner();
    const { connection, services } = await connect(db, principal, "tosend", [toSendFixtures.info]);
    await expect(
      runOperation(
        principal,
        connectionsAcceptPolicy,
        { id: connection.id, accept: false },
        { db, services },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["campaigns:send"],
      surface: "rest",
    });
    await expect(
      runOperation(
        key,
        connectionsAcceptPolicy,
        { id: connection.id, accept: true },
        { db, services },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const resend = await connect(db, principal, "resend", [
      resendFixtures.domainsOk,
      resendFixtures.webhookCreated,
    ]);
    await expect(
      runOperation(
        principal,
        connectionsAcceptPolicy,
        { id: resend.connection.id, accept: true },
        { db, services },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("follows the selected connection: a campaign provider passes without a warning", async () => {
    const { db, workspaceId, principal } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    const resend = await connect(db, principal, "resend", [
      resendFixtures.domainsOk,
      resendFixtures.webhookCreated,
    ]);
    // The first connection stays selected until the owner picks another.
    expect(resend.connection.selected).toBe(false);
    expect((await checkCampaignPolicy(db, workspaceId)).allowed).toBe(false);
    await runOperation(
      principal,
      connectionsSelect,
      { id: resend.connection.id },
      { db, services: resend.services },
    );
    expect(await checkCampaignPolicy(db, workspaceId)).toMatchObject({
      allowed: true,
      provider: "resend",
    });
  });

  it("lets a toSend connection send an owner alert without the warning (R63)", async () => {
    const { db, workspaceId, principal } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    await verifiedDomain(db, workspaceId);
    const mock = mockFetch([TOSEND_BATCH_OK]);
    const services = await testServices({ fetch: mock.fetch });
    const result = await sendSystemEmail({ db, services }, workspaceId, {
      to: "owner@example.com",
      subject: "Your campaign paused",
      html: "<p>The daily limit was reached.</p>",
    });
    expect(result).toEqual({ recipientId: "system", outcome: "sent", providerMessageId: "ts-1" });
    const email = JSON.parse(mock.calls[0]?.body ?? "{}").emails[0];
    expect(email.from).toEqual({ email: "alerts@mail.example.com", name: "Envelopen" });
    expect(email.headers).toEqual({ "Auto-Submitted": "auto-generated" });
    // The campaign gate still blocks.
    expect((await checkCampaignPolicy(db, workspaceId)).allowed).toBe(false);
  });
});

describe("test sends (R30, R72)", () => {
  it("rejects an address outside the allowlist without calling the provider", async () => {
    const { db, workspaceId, principal } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    await verifiedDomain(db, workspaceId);
    const mock = mockFetch([TOSEND_BATCH_OK]);
    const services = await testServices({ fetch: mock.fetch });
    await expect(
      runOperation(
        principal,
        campaignsSendTest,
        { to: ["stranger@example.org"], from: "news@mail.example.com" },
        { db, services },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      details: { notAllowed: ["stranger@example.org"] },
    });
    expect(mock.calls).toEqual([]);
    expect(
      (await auditActions(db, workspaceId)).some((row) => row.action === TEST_SEND_ACTION),
    ).toBe(false);
  });

  it("sends to the owner and to added addresses with both unsubscribe headers, and completes the checklist step", async () => {
    const { db, workspaceId, principal, userId } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    await verifiedDomain(db, workspaceId);
    const mock = mockFetch([
      {
        ...TOSEND_BATCH_OK,
        response: {
          status: 200,
          body: {
            results: [
              { status: "success", message_id: "ts-1" },
              { status: "success", message_id: "ts-2" },
            ],
          },
        },
      },
    ]);
    const services = await testServices({ fetch: mock.fetch });
    await runOperation(
      principal,
      testAddressesAdd,
      { email: " Colleague@Example.org " },
      { db, services },
    );
    const list = await runOperation(principal, testAddressesList, {}, { db });
    expect(list.items.map((item) => [item.email, item.owner])).toEqual([
      [`${userId}@example.com`, true],
      ["colleague@example.org", false],
    ]);

    // The transactional-only policy does not apply to a test send.
    const result = await runOperation(
      principal,
      campaignsSendTest,
      {
        to: [`${userId}@example.com`, "colleague@example.org"],
        from: "news@mail.example.com",
        fromName: "Course Academy",
      },
      { db, services },
    );
    expect(result.results.map((item) => item.outcome)).toEqual(["sent", "sent"]);
    const emails = JSON.parse(mock.calls[0]?.body ?? "{}").emails;
    expect(emails[0].subject).toBe("[Test] Envelopen test email");
    expect(emails[0].headers).toEqual({
      "List-Unsubscribe": "<https://envelopen.test/u/test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(
      (await auditActions(db, workspaceId)).some((row) => row.action === TEST_SEND_ACTION),
    ).toBe(true);
    const status = await runOperation(principal, onboardingStatus, {}, { db });
    expect(status.steps.find((step) => step.id === "send_test")?.status).toBe("done");
  });

  it("rejects a From address outside the workspace's sending domains", async () => {
    const { db, workspaceId, principal, userId } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    await verifiedDomain(db, workspaceId);
    const services = await testServices({ fetch: mockFetch([]).fetch });
    await expect(
      runOperation(
        principal,
        campaignsSendTest,
        { to: [`${userId}@example.com`], from: "x@other.example" },
        { db, services },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("records no test send when the provider sends nothing", async () => {
    const { db, workspaceId, principal, userId } = await owner();
    await connect(db, principal, "tosend", [toSendFixtures.info]);
    await verifiedDomain(db, workspaceId);
    const services = await testServices({
      fetch: mockFetch([toSendFixtures.batchNoCredits]).fetch,
    });
    await expect(
      runOperation(
        principal,
        campaignsSendTest,
        { to: [`${userId}@example.com`], from: "a@mail.example.com" },
        { db, services },
      ),
    ).rejects.toMatchObject({ code: "provider_error", message: "Insufficient credit balance" });
    expect(
      (await auditActions(db, workspaceId)).some((row) => row.action === TEST_SEND_ACTION),
    ).toBe(false);
  });

  it("keeps the allowlist for the owner: keys can read it and send tests, not edit it", async () => {
    const { db, workspaceId, principal } = await owner();
    const services = await testServices();
    const added = await runOperation(
      principal,
      testAddressesAdd,
      { email: "qa@example.org" },
      { db, services },
    );
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 2,
      scopes: ["campaigns:read", "campaigns:write"],
      surface: "mcp",
    });
    expect((await runOperation(key, testAddressesList, {}, { db })).items).toHaveLength(2);
    await expect(
      runOperation(key, testAddressesAdd, { email: "me@evil.example" }, { db }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      runOperation(key, testAddressesRemove, { id: added.id }, { db }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await runOperation(principal, testAddressesRemove, { id: added.id ?? 0 }, { db });
    expect((await runOperation(principal, testAddressesList, {}, { db })).items).toHaveLength(1);
  });
});
