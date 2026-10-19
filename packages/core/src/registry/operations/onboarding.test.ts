import type { DbConnection } from "@envelopen/db";
import { describe, expect, it } from "vitest";
import { createOwnedWorkspace, createUser, testDb } from "../../../test/fixtures";
import { writeAudit } from "../../audit";
import { runOperation } from "../../executor";
import { apiKeyPrincipal, type Principal, sessionPrincipal } from "../../principal";
import { onboardingStatus, TEST_SEND_ACTION } from "./onboarding";

async function owner(name = "Onboarding") {
  const conn = testDb();
  const userId = await createUser(conn);
  const workspaceId = await createOwnedWorkspace(conn, userId, name);
  return { conn, workspaceId, principal: sessionPrincipal({ workspaceId, userId }) };
}

async function statusOf(conn: DbConnection, principal: Principal) {
  const result = await runOperation(principal, onboardingStatus, {}, { db: conn });
  return Object.fromEntries(result.steps.map((step) => [step.id, step]));
}

async function addConnection(
  conn: DbConnection,
  workspaceId: number,
  status: "active" | "error" | "disabled" = "active",
  statusDetail: string | null = null,
): Promise<number> {
  const row = await conn.db
    .insertInto("provider_connections")
    .values({
      workspace_id: workspaceId,
      provider: "ses",
      name: "Amazon SES",
      policy: "campaign",
      credentials_encrypted: "x",
      credentials_key_version: 1,
      webhook_secret_encrypted: null,
      provider_refs: null,
      status,
      status_detail: statusDetail,
      policy_warning_accepted_at: null,
      policy_warning_accepted_by: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addDomain(
  conn: DbConnection,
  workspaceId: number,
  values: { verified_at?: number | null; dkim_status?: string } = {},
) {
  await conn.db
    .insertInto("sending_domains")
    .values({
      workspace_id: workspaceId,
      connection_id: null,
      domain: "mail.example.com",
      tracking_domain: null,
      last_checked_at: null,
      verified_at: values.verified_at ?? null,
      ...(values.dkim_status ? { dkim_status: values.dkim_status } : {}),
    })
    .execute();
}

async function addContact(conn: DbConnection, workspaceId: number) {
  await conn.db
    .insertInto("contacts")
    .values({
      workspace_id: workspaceId,
      email: "ana@example.com",
      first_name: null,
      last_name: null,
      consent_basis: "explicit_opt_in",
      consent_source: "test",
      consent_at: Date.now(),
      source: "ui",
    })
    .execute();
}

describe("onboarding.status", () => {
  it("starts with two steps to do and two blocked", async () => {
    const { conn, principal } = await owner();
    const result = await runOperation(principal, onboardingStatus, {}, { db: conn });
    expect(result.total).toBe(4);
    expect(result.completed).toBe(0);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["connect_provider", "todo"],
      ["verify_domain", "blocked"],
      ["import_contacts", "todo"],
      ["send_test", "blocked"],
    ]);
    for (const step of result.steps) expect(step.guide).toMatch(/^docs\/guides\//);
  });

  it("marks the provider step done for an active connection", async () => {
    const { conn, workspaceId, principal } = await owner();
    await addConnection(conn, workspaceId);
    const steps = await statusOf(conn, principal);
    expect(steps.connect_provider).toMatchObject({ status: "done" });
    expect(steps.verify_domain).toMatchObject({ status: "todo" });
  });

  it("blocks the provider step on a connection error and shows its detail", async () => {
    const { conn, workspaceId, principal } = await owner();
    await addConnection(conn, workspaceId, "error", "SES production access pending.");
    const steps = await statusOf(conn, principal);
    expect(steps.connect_provider).toMatchObject({
      status: "blocked",
      detail: "SES production access pending.",
    });
  });

  it("waits for DNS, blocks on a failed record, and is done when verified", async () => {
    const pending = await owner();
    await addConnection(pending.conn, pending.workspaceId);
    await addDomain(pending.conn, pending.workspaceId);
    expect((await statusOf(pending.conn, pending.principal)).verify_domain).toMatchObject({
      status: "waiting",
    });

    const failed = await owner();
    await addConnection(failed.conn, failed.workspaceId);
    await addDomain(failed.conn, failed.workspaceId, { dkim_status: "fail" });
    const failedStep = (await statusOf(failed.conn, failed.principal)).verify_domain;
    expect(failedStep?.status).toBe("blocked");
    expect(failedStep?.detail).toContain("DKIM");

    const verified = await owner();
    await addConnection(verified.conn, verified.workspaceId);
    await addDomain(verified.conn, verified.workspaceId, { verified_at: Date.now() });
    const steps = await statusOf(verified.conn, verified.principal);
    expect(steps.verify_domain).toMatchObject({ status: "done" });
    expect(steps.send_test).toMatchObject({ status: "todo" });
  });

  it("marks contacts done when the workspace has a contact, and only that workspace", async () => {
    const first = await owner("First");
    const second = await owner("Second");
    await addContact(first.conn, first.workspaceId);
    expect((await statusOf(first.conn, first.principal)).import_contacts).toMatchObject({
      status: "done",
    });
    expect((await statusOf(second.conn, second.principal)).import_contacts).toMatchObject({
      status: "todo",
    });
  });

  it("marks the test step done after a test send", async () => {
    const { conn, principal } = await owner();
    await writeAudit(conn.db, principal, { action: TEST_SEND_ACTION });
    const result = await runOperation(principal, onboardingStatus, {}, { db: conn });
    expect(result.steps.find((step) => step.id === "send_test")?.status).toBe("done");
    expect(result.completed).toBe(1);
  });

  it("is readable with stats:read and through MCP", async () => {
    const { conn, workspaceId } = await owner();
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["stats:read"],
      surface: "mcp",
    });
    await expect(runOperation(key, onboardingStatus, {}, { db: conn })).resolves.toMatchObject({
      total: 4,
    });
    const noScope = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read"],
      surface: "rest",
    });
    await expect(runOperation(noScope, onboardingStatus, {}, { db: conn })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
