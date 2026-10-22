import type { DbConnection } from "@envelopen/db";
import { postmarkAuthorization, svixSign } from "@envelopen/providers";
import {
  MAILGUN_EU,
  mailgunEventData,
  mailgunFixtures,
  mailgunHook,
} from "@envelopen/providers/conformance/fixtures/mailgun";
import { postmarkFixtures } from "@envelopen/providers/conformance/fixtures/postmark";
import { resendFixtures } from "@envelopen/providers/conformance/fixtures/resend";
import { sesFixtures, TOPIC_ARN } from "@envelopen/providers/conformance/fixtures/ses";
import { mockFetch, type RecordedExchange } from "@envelopen/providers/conformance/mock-fetch";
import { createSnsSigner } from "@envelopen/providers/conformance/sns-signer";
import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { apiKeyPrincipal, sessionPrincipal } from "../principal";
import { onboardingStatus } from "../registry/operations/onboarding";
import {
  connectionsCreate,
  connectionsDelete,
  connectionsGet,
  connectionsList,
  connectionsSetupEvents,
  connectionsSetWebhookSecret,
  connectionsTest,
} from "./operations";
import { receiveProviderWebhook } from "./webhooks";

async function owner(name = "Providers") {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, name);
  return { db, userId, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

async function servicesWith(exchanges: RecordedExchange[]) {
  const mock = mockFetch(exchanges);
  return { mock, services: await testServices({ fetch: mock.fetch }) };
}

const resendDomains = resendFixtures.domainsOk;

async function connectResend(
  exchanges: RecordedExchange[] = [resendDomains, resendFixtures.webhookCreated],
) {
  const setup = await owner();
  const { mock, services } = await servicesWith(exchanges);
  const created = await runOperation(
    setup.principal,
    connectionsCreate,
    { provider: "resend", credentials: { apiKey: "re_live_abcdef123456" } },
    { db: setup.db, services },
  );
  return { ...setup, mock, services, created };
}

async function signedResendRequest(
  workspaceId: number,
  connectionId: number,
  body: string,
  id = "msg_test_1",
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await svixSign(resendFixtures.webhookSecret, id, timestamp, body);
  return {
    url: `https://envelopen.test/hooks/resend/${workspaceId}/${connectionId}`,
    method: "POST",
    headers: new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    }),
    body,
  };
}

async function countEvents(db: DbConnection, workspaceId: number) {
  const row = await db.db
    .selectFrom("provider_events")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe("one-field connect with auto-webhook (KTD13)", () => {
  it("creates the Resend webhook, stores its secret, and a test event verifies", async () => {
    const { db, workspaceId, services, mock, created, principal } = await connectResend();
    expect(created).toMatchObject({
      provider: "resend",
      status: "active",
      eventsSetup: "auto",
      selected: true,
      webhook: { secret: null, needsSecret: false, steps: [] },
    });
    // The webhook points at this connection.
    const createCall = mock.calls.find((call) => call.url === "https://api.resend.com/webhooks");
    expect(JSON.parse(createCall?.body ?? "{}").endpoint).toBe(
      `https://envelopen.test/hooks/resend/${workspaceId}/${created.id}`,
    );

    const request = await signedResendRequest(
      workspaceId,
      created.id,
      resendFixtures.events.bounced,
    );
    const outcome = await receiveProviderWebhook(
      { db, services },
      { provider: "resend", workspaceId, connectionId: created.id },
      request,
    );
    expect(outcome).toMatchObject({ status: 200, received: 1, stored: 1 });
    const stored = await db.db
      .selectFrom("provider_events")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      type: "bounce_hard",
      provider: "resend",
      provider_message_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      email_hash: await services.hashEmail("student1@example.org"),
      processed_at: null,
    });
    // A hard bounce writes the suppression at once.
    const suppression = await db.db
      .selectFrom("suppressions")
      .select(["reason", "source"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(suppression).toEqual({ reason: "hard_bounce", source: "provider:resend" });

    // The connection step of the checklist is done.
    const status = await runOperation(principal, onboardingStatus, {}, { db });
    expect(status.steps[0]).toMatchObject({ id: "connect_provider", status: "done" });
  });

  it("stores a replayed webhook once", async () => {
    const { db, workspaceId, services, created } = await connectResend();
    const request = await signedResendRequest(
      workspaceId,
      created.id,
      resendFixtures.events.delivered,
      "msg_replay",
    );
    const target = { provider: "resend", workspaceId, connectionId: created.id };
    expect((await receiveProviderWebhook({ db, services }, target, request)).stored).toBe(1);
    const again = await receiveProviderWebhook({ db, services }, target, request);
    expect(again).toMatchObject({ status: 200, stored: 0 });
    expect(await countEvents(db, workspaceId)).toBe(1);
  });

  it("rejects a forged or changed webhook and records nothing", async () => {
    const { db, workspaceId, services, created } = await connectResend();
    const target = { provider: "resend", workspaceId, connectionId: created.id };
    const request = await signedResendRequest(
      workspaceId,
      created.id,
      resendFixtures.events.bounced,
    );
    const changed = {
      ...request,
      body: resendFixtures.events.bounced.replace("student1", "student9"),
    };
    expect((await receiveProviderWebhook({ db, services }, target, changed)).status).toBe(401);
    const unsigned = { ...request, headers: new Headers() };
    expect((await receiveProviderWebhook({ db, services }, target, unsigned)).status).toBe(401);
    expect(await countEvents(db, workspaceId)).toBe(0);
    const suppressions = await db.db
      .selectFrom("suppressions")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .execute();
    expect(suppressions).toEqual([]);
  });

  it("falls back to manual steps with the webhook URL when auto-webhook fails", async () => {
    const failing = {
      ...resendFixtures.webhookCreated,
      response: { status: 500, body: { message: "Oops" } },
    };
    const { db, workspaceId, services, created, principal } = await connectResend([
      resendDomains,
      failing,
    ]);
    const url = `https://envelopen.test/hooks/resend/${workspaceId}/${created.id}`;
    expect(created).toMatchObject({
      status: "active",
      eventsSetup: "manual",
      webhook: { url, secretSource: "provider", needsSecret: true },
    });
    expect(created.webhook.steps.join("\n")).toContain(url);
    expect(created.warnings.join(" ")).toContain("Automatic webhook setup did not finish");

    // The owner pastes the secret from the Resend dashboard, and events verify.
    await runOperation(
      principal,
      connectionsSetWebhookSecret,
      { id: created.id, secret: resendFixtures.webhookSecret },
      { db, services },
    );
    const detail = await runOperation(
      principal,
      connectionsGet,
      { id: created.id },
      { db, services },
    );
    expect(detail.webhook.needsSecret).toBe(false);
    const request = await signedResendRequest(
      workspaceId,
      created.id,
      resendFixtures.events.complained,
    );
    const outcome = await receiveProviderWebhook(
      { db, services },
      { provider: "resend", workspaceId, connectionId: created.id },
      request,
    );
    expect(outcome).toMatchObject({ status: 200, stored: 1 });
  });

  it("retries the automatic setup on request", async () => {
    const failing = { ...resendFixtures.webhookCreated, response: "timeout" as const, times: 1 };
    const { db, services, created, principal } = await connectResend([
      resendDomains,
      failing,
      resendFixtures.webhookCreated,
    ]);
    expect(created.eventsSetup).toBe("manual");
    const retried = await runOperation(
      principal,
      connectionsSetupEvents,
      { id: created.id },
      { db, services },
    );
    expect(retried).toMatchObject({ eventsSetup: "auto", warnings: [] });
  });

  it("shows Envelopen's secret for a manual Postmark setup, and verifies its Basic auth", async () => {
    const setup = await owner();
    const { services } = await servicesWith([
      postmarkFixtures.server,
      postmarkFixtures.streams("Custom"),
      {
        ...postmarkFixtures.webhookCreated,
        response: { status: 422, body: { ErrorCode: 1364, Message: "Verification failed." } },
      },
    ]);
    const created = await runOperation(
      setup.principal,
      connectionsCreate,
      { provider: "postmark", credentials: { serverToken: "pm-token-123" } },
      { db: setup.db, services },
    );
    expect(created.eventsSetup).toBe("manual");
    expect(created.webhook.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const outcome = await receiveProviderWebhook(
      { db: setup.db, services },
      { provider: "postmark", workspaceId: setup.workspaceId, connectionId: created.id },
      {
        url: created.webhook.url ?? "",
        method: "POST",
        headers: new Headers({
          authorization: postmarkAuthorization(created.webhook.secret ?? ""),
        }),
        body: postmarkFixtures.events.delivery,
      },
    );
    expect(outcome).toMatchObject({ status: 200, stored: 1 });
  });

  it("creates the SES event chain, then confirms the SNS subscription from a signed message", async () => {
    const setup = await owner();
    const signer = await createSnsSigner();
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t1";
    const { mock, services } = await servicesWith([
      sesFixtures.accountProduction,
      sesFixtures.createConfigurationSet,
      sesFixtures.sns((action) => ({
        status: 200,
        body:
          action === "CreateTopic"
            ? sesFixtures.createTopicXml
            : action === "Subscribe"
              ? sesFixtures.subscribeXml
              : "<ok/>",
      })),
      sesFixtures.createEventDestination,
      {
        label: "cert",
        method: "GET",
        url: /\.pem$/,
        response: { status: 200, body: signer.certificatePem },
      },
      {
        label: "confirm",
        method: "GET",
        url: subscribeUrl,
        response: { status: 200, body: "<ConfirmSubscriptionResponse/>" },
      },
    ]);
    const created = await runOperation(
      setup.principal,
      connectionsCreate,
      { provider: "ses", credentials: sesFixtures.credentials },
      { db: setup.db, services },
    );
    expect(created).toMatchObject({
      eventsSetup: "auto",
      accountLabel: "us-east-1, production access",
    });
    const subscribe = new URLSearchParams(
      mock.calls.find((call) => call.body.includes("Action=Subscribe"))?.body,
    );
    const endpoint = subscribe.get("Endpoint") ?? "";
    expect(endpoint).toMatch(new RegExp(`/hooks/ses/${setup.workspaceId}/${created.id}/[\\w-]+$`));
    expect(endpoint).not.toContain("?");

    const confirmation = await signer.sign({
      Type: "SubscriptionConfirmation",
      MessageId: "m-1",
      Token: "t1",
      TopicArn: TOPIC_ARN,
      Message: "Confirm",
      SubscribeURL: subscribeUrl,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-1.pem",
    });
    const target = { provider: "ses", workspaceId: setup.workspaceId, connectionId: created.id };
    const deps = { db: setup.db, services };
    const outcome = await receiveProviderWebhook(deps, target, {
      url: endpoint,
      method: "POST",
      headers: new Headers({ "x-amz-sns-message-type": "SubscriptionConfirmation" }),
      body: JSON.stringify(confirmation),
    });
    expect(outcome).toMatchObject({ status: 200, confirmedSubscription: true });
    expect(mock.calls.some((call) => call.url === subscribeUrl)).toBe(true);

    // The URL of a connection from before, with the token in the query, still works.
    const token = endpoint.split("/").at(-1) ?? "";
    const base = endpoint.slice(0, -token.length - 1);
    const legacy = await receiveProviderWebhook(deps, target, {
      url: `${base}?token=${token}`,
      method: "POST",
      headers: new Headers({ "x-amz-sns-message-type": "SubscriptionConfirmation" }),
      body: JSON.stringify(confirmation),
    });
    expect(legacy.status).toBe(200);

    // The same signed message posted without the URL token is rejected.
    const noToken = await receiveProviderWebhook(deps, target, {
      url: base,
      method: "POST",
      headers: new Headers(),
      body: JSON.stringify(confirmation),
    });
    expect(noToken.status).toBe(401);
  });
});

describe("connect errors", () => {
  it("rejects a wrong key and stores nothing", async () => {
    const setup = await owner();
    const { services } = await servicesWith([
      {
        ...resendDomains,
        response: { status: 401, body: { name: "invalid_api_key", message: "API key is invalid" } },
      },
    ]);
    await expect(
      runOperation(
        setup.principal,
        connectionsCreate,
        { provider: "resend", credentials: { apiKey: "re_wrong" } },
        {
          db: setup.db,
          services,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", message: "Resend rejected the API key." });
    expect(
      (await runOperation(setup.principal, connectionsList, {}, { db: setup.db })).items,
    ).toEqual([]);
  });

  it.each([
    ["a 5xx", { status: 503, body: { name: "service_unavailable" } }],
    ["a timeout", "timeout" as const],
    ["a network error", "network" as const],
  ])(
    "reports %s during connect as a provider error and stores nothing",
    async (_label, response) => {
      const setup = await owner();
      const { services } = await servicesWith([{ ...resendDomains, response }]);
      await expect(
        runOperation(
          setup.principal,
          connectionsCreate,
          { provider: "resend", credentials: { apiKey: "re_abc" } },
          {
            db: setup.db,
            services,
          },
        ),
      ).rejects.toMatchObject({ code: "provider_error" });
      expect(
        (await runOperation(setup.principal, connectionsList, {}, { db: setup.db })).items,
      ).toEqual([]);
    },
  );

  it("validates the fields before any provider call", async () => {
    const setup = await owner();
    const { mock, services } = await servicesWith([]);
    const run = (input: unknown) =>
      runOperation(setup.principal, connectionsCreate, input, { db: setup.db, services });
    await expect(run({ provider: "resend", credentials: {} })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      run({ provider: "resend", credentials: { apiKey: "not-a-key" } }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(run({ provider: "nope", credentials: {} })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      run({ provider: "resend", credentials: { apiKey: "re_x", extra: "y" } }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(mock.calls).toEqual([]);
  });

  it("marks a connection as failing when a later check fails", async () => {
    const { db, principal, created } = await connectResend();
    const { services } = await servicesWith([
      { ...resendDomains, response: { status: 401, body: { name: "invalid_api_key" } } },
    ]);
    const tested = await runOperation(
      principal,
      connectionsTest,
      { id: created.id },
      { db, services },
    );
    expect(tested).toMatchObject({ status: "error", statusDetail: "Resend rejected the API key." });
    const status = await runOperation(principal, onboardingStatus, {}, { db });
    expect(status.steps[0]).toMatchObject({
      status: "blocked",
      detail: "Resend rejected the API key.",
    });
  });
});

describe("stored credentials", () => {
  it("are not readable in plaintext", async () => {
    const { db, workspaceId } = await connectResend();
    const row = await db.db
      .selectFrom("provider_connections")
      .select([
        "credentials_encrypted",
        "credentials_key_version",
        "webhook_secret_encrypted",
        "provider_refs",
      ])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(row.credentials_key_version).toBe(1);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("re_live_abcdef123456");
    expect(stored).not.toContain(resendFixtures.webhookSecret);
    expect(stored).not.toContain(resendFixtures.webhookSecret.slice(6));
  });

  it("never appear in an API response", async () => {
    const { db, created, principal, services } = await connectResend();
    const list = await runOperation(principal, connectionsList, {}, { db });
    const detail = await runOperation(
      principal,
      connectionsGet,
      { id: created.id },
      { db, services },
    );
    const text = JSON.stringify([created, list, detail]);
    expect(text).not.toContain("re_live_abcdef123456");
    expect(text).not.toContain(resendFixtures.webhookSecret);
  });
});

describe("workspace isolation and scopes", () => {
  it("keeps connections and webhooks inside their workspace", async () => {
    const first = await connectResend();
    const second = await owner("Second");
    expect(
      (await runOperation(second.principal, connectionsList, {}, { db: second.db })).items,
    ).toEqual([]);
    await expect(
      runOperation(
        second.principal,
        connectionsGet,
        { id: first.created.id },
        { db: second.db, services: first.services },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      runOperation(
        second.principal,
        connectionsDelete,
        { id: first.created.id },
        { db: second.db, services: first.services },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    // A webhook path with another workspace's id finds no connection.
    const request = await signedResendRequest(
      second.workspaceId,
      first.created.id,
      resendFixtures.events.bounced,
    );
    const outcome = await receiveProviderWebhook(
      { db: second.db, services: first.services },
      { provider: "resend", workspaceId: second.workspaceId, connectionId: first.created.id },
      request,
    );
    expect(outcome.status).toBe(404);
    // And a path with the wrong provider name finds none either.
    const wrongProvider = await receiveProviderWebhook(
      { db: first.db, services: first.services },
      { provider: "postmark", workspaceId: first.workspaceId, connectionId: first.created.id },
      request,
    );
    expect(wrongProvider.status).toBe(404);
  });

  it("lets a stats:read key read the status but not manage connections, and MCP never", async () => {
    const { db, workspaceId, created, services } = await connectResend();
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 7,
      scopes: ["stats:read", "campaigns:send"],
      surface: "rest",
    });
    const list = await runOperation(key, connectionsList, {}, { db });
    expect(list.items).toHaveLength(1);
    for (const [operation, input] of [
      [connectionsGet, { id: created.id }],
      [connectionsCreate, { provider: "resend", credentials: { apiKey: "re_x" } }],
      [connectionsDelete, { id: created.id }],
      [connectionsTest, { id: created.id }],
    ] as const) {
      await expect(
        runOperation(key, operation as never, input, { db, services }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const mcp = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 7,
      scopes: ["stats:read"],
      surface: "mcp",
    });
    await expect(runOperation(mcp, connectionsList, {}, { db })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("removes the auto-created webhook on delete and clears the selection", async () => {
    const { db, principal, created, workspaceId } = await connectResend();
    const { mock, services } = await servicesWith([resendFixtures.webhookDeleted]);
    const removed = await runOperation(
      principal,
      connectionsDelete,
      { id: created.id },
      { db, services },
    );
    expect(removed).toEqual({ id: created.id, webhookRemoved: true });
    expect(mock.calls[0]?.url).toBe(
      "https://api.resend.com/webhooks/4dd369bc-aa82-4ff3-97de-514ae3000ee0",
    );
    const workspace = await db.db
      .selectFrom("workspaces")
      .select("sending_connection_id")
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(workspace.sending_connection_id).toBeNull();
  });
});

describe("Mailgun connect (U20, KTD15)", () => {
  const credentials = {
    apiKey: mailgunFixtures.credentials.apiKey,
    domain: "mail.example.com",
    region: "eu",
    webhookSigningKey: mailgunFixtures.signingKey,
  };

  it("checks the EU API, creates the webhook, and verifies events with the signing key", async () => {
    const setup = await owner("Mailgun");
    const { mock, services } = await servicesWith([
      mailgunFixtures.domainOk(MAILGUN_EU),
      mailgunFixtures.webhookCreated(MAILGUN_EU),
    ]);
    const created = await runOperation(
      setup.principal,
      connectionsCreate,
      { provider: "mailgun", credentials },
      { db: setup.db, services },
    );
    expect(created).toMatchObject({ provider: "mailgun", status: "active", eventsSetup: "auto" });
    expect(mock.calls.map((call) => new URL(call.url).host)).toEqual([
      "api.eu.mailgun.net",
      "api.eu.mailgun.net",
    ]);
    const request = await mailgunHook(mailgunEventData("complained"), { timestampMs: Date.now() });
    const target = {
      provider: "mailgun",
      workspaceId: setup.workspaceId,
      connectionId: created.id,
    };
    const outcome = await receiveProviderWebhook({ db: setup.db, services }, target, request);
    expect(outcome).toMatchObject({ status: 200, stored: 1 });
    const replay = await receiveProviderWebhook({ db: setup.db, services }, target, request);
    expect(replay).toMatchObject({ status: 401, stored: 0 });
  });

  it("keeps the signing key when the webhook setup falls back to manual steps", async () => {
    const setup = await owner("Mailgun manual");
    const { services } = await servicesWith([
      mailgunFixtures.domainOk(MAILGUN_EU),
      {
        label: "webhook create refused",
        method: "POST",
        url: `${MAILGUN_EU}/v4/domains/mail.example.com/webhooks`,
        response: { status: 400, body: { message: "Webhook already exists" } },
      },
    ]);
    const created = await runOperation(
      setup.principal,
      connectionsCreate,
      { provider: "mailgun", credentials },
      { db: setup.db, services },
    );
    expect(created).toMatchObject({
      eventsSetup: "manual",
      webhook: { secretSource: "provider", needsSecret: false, secret: null },
    });
    const request = await mailgunHook(mailgunEventData("delivered"), { timestampMs: Date.now() });
    const outcome = await receiveProviderWebhook(
      { db: setup.db, services },
      { provider: "mailgun", workspaceId: setup.workspaceId, connectionId: created.id },
      request,
    );
    expect(outcome).toMatchObject({ status: 200, stored: 1 });
  });

  it("refuses a region that is not US or EU before any provider call", async () => {
    const setup = await owner("Mailgun region");
    const { mock, services } = await servicesWith([]);
    await expect(
      runOperation(
        setup.principal,
        connectionsCreate,
        { provider: "mailgun", credentials: { ...credentials, region: "ap" } },
        { db: setup.db, services },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mock.calls).toEqual([]);
  });
});
