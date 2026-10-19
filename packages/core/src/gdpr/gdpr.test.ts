import { env } from "cloudflare:workers";
import type { DbConnection } from "@envelopen/db";
import { describe, expect, it } from "vitest";
import {
  type SentCampaign,
  seedCampaignWorkspace,
  seedSentCampaign,
} from "../../test/campaign-fixtures";
import { type TestServices, testDb, testServices } from "../../test/fixtures";
import { consentRecord } from "../consent/operations";
import { contactsGet, contactsUpsert } from "../contacts/operations";
import { isOperationError } from "../errors";
import { flushEvents } from "../events/flush";
import type { TrackingEvent } from "../events/model";
import { runOperation } from "../executor";
import { importsCreate, importsGet, importsPreview, importsStart } from "../import/operations";
import { runImportJob } from "../import/process";
import { apiKeyPrincipal, type Principal } from "../principal";
import { auditList } from "../registry/operations/audit";
import type { ImportJob } from "../services";
import { containsPattern } from "./erase";
import type { ContactExport } from "./export";
import { contactsErase, contactsExport } from "./operations";

// Data rights (R21): the JSON export of one contact, and the erase that removes the
// personal data, keeps the rollups, and keeps the keyed suppression hash.

const T0 = Date.UTC(2026, 9, 19, 9);
const LATER = T0 + 60 * 60 * 1000;
// Each setup has its own address and surname, so a scan finds only its own traces.
let EMAIL = "";
let SURNAME = "";

async function setup() {
  const tag = crypto.randomUUID().slice(0, 8);
  SURNAME = `Quintessa${tag}`;
  EMAIL = `zelda.${SURNAME.toLowerCase()}@example.net`;
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, { contacts: 2 });
  const run = <T>(principal: Principal, op: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(principal, op, input, { db, services, now: () => LATER }) as Promise<T>;
  const owner = seeded.principal;
  const upserted = await run<{ contact: { id: number } }>(owner, contactsUpsert, {
    email: ` ${EMAIL.toUpperCase()} `,
    firstName: "Zelda",
    lastName: SURNAME,
    consentBasis: "existing_customer",
    tags: ["Course 101"],
    listIds: [seeded.listId],
    fields: { cohort: `${SURNAME} 2026` },
  });
  const contactId = upserted.contact.id;
  await run(owner, consentRecord, {
    id: contactId,
    basis: "explicit_opt_in",
    note: `Ticked the box at the ${SURNAME} fair.`,
  });
  const sent = await seedSentCampaign(db, seeded, { startedAt: T0 });
  const recipient = sent.recipients.find((item) => item.contactId === contactId);
  if (!recipient) throw new Error("The campaign did not include the contact.");
  await flushEvents(db, seeded.workspaceId, trackingEvents(sent, recipient), LATER);
  await addTraces(db, services, seeded.workspaceId, recipient);
  return { db, services, seeded, sent, recipient, contactId, owner, run };
}

function trackingEvents(
  sent: SentCampaign,
  recipient: SentCampaign["recipients"][number],
): TrackingEvent[] {
  const base = {
    source: "tracking" as const,
    campaignId: sent.campaignId,
    recipientId: recipient.id,
    contactId: recipient.contactId,
    machine: false,
    bot: false,
    reason: null,
  };
  return [
    { ...base, type: "open", linkId: null, occurredAt: T0 + 60_000 },
    { ...base, type: "click", linkId: sent.linkIds[0] ?? null, occurredAt: T0 + 120_000 },
  ];
}

/** Places where the address can end up besides the contact tables. */
async function addTraces(
  db: DbConnection,
  services: TestServices,
  workspaceId: number,
  recipient: SentCampaign["recipients"][number],
) {
  const emailHash = await services.hashEmail(EMAIL);
  await db.db
    .insertInto("provider_events")
    .values({
      workspace_id: workspaceId,
      connection_id: null,
      provider: "resend",
      event_id: `evt-${EMAIL}`,
      type: "bounce_soft",
      provider_message_id: recipient.messageId,
      email_hash: emailHash,
      detail: `Mailbox full for ${EMAIL}`,
      occurred_at: T0 + 30_000,
    })
    .execute();
  await db.db
    .updateTable("campaign_recipients")
    .set({ error: `Temporary failure for ${EMAIL}` })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", recipient.id)
    .execute();
  await db.db
    .insertInto("test_addresses")
    .values({ workspace_id: workspaceId, email: EMAIL })
    .execute();
  await db.db
    .insertInto("idempotency_keys")
    .values({
      workspace_id: workspaceId,
      principal_id: "api_key:1",
      method: "POST",
      route: "/contacts",
      key: `upsert-${EMAIL}`,
      request_hash: "hash",
      response_status: 200,
      response_body: JSON.stringify({ contact: { email: EMAIL } }),
      expires_at: LATER + 86_400_000,
    })
    .execute();
  await db.db
    .insertInto("audit_log")
    .values({
      workspace_id: workspaceId,
      actor_type: "system",
      actor_id: null,
      surface: "system",
      api_key_id: null,
      action: "suppressions.add",
      target_type: "suppression",
      target_id: null,
      metadata: JSON.stringify({ note: `Complaint from ${EMAIL}` }),
      ip: null,
    })
    .execute();
}

/** Every text value in every table of the database that contains one of the markers. */
async function plaintextHits(markers: readonly string[]): Promise<string[]> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const hits: string[] = [];
  for (const { name } of tables.results) {
    const columns = await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{
      name: string;
      type: string;
    }>();
    // SQLite stores text in any column without a strict type, so check every column
    // that is not an integer or a real.
    const textColumns = columns.results.filter(
      (column) => !/INT|REAL|FLOA|DOUB/i.test(column.type),
    );
    for (const column of textColumns) {
      for (const marker of markers) {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${column.name}" AS TEXT) LIKE ? ESCAPE '\\'`,
        )
          .bind(containsPattern(marker))
          .first<{ n: number }>();
        if ((row?.n ?? 0) > 0) hits.push(`${name}.${column.name} has "${marker}"`);
      }
    }
  }
  return hits;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOperationError(error)) return error.code;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

describe("contact export", () => {
  it("contains the contact, memberships, consent events, campaigns, events, and suppression status", async () => {
    const { seeded, sent, contactId, owner, run } = await setup();
    const data = await run<ContactExport>(owner, contactsExport, { id: contactId });

    expect(data.exportedAt).toBe(LATER);
    expect(data.contact).toMatchObject({
      id: contactId,
      email: EMAIL,
      firstName: "Zelda",
      lastName: SURNAME,
      consentBasis: "explicit_opt_in",
      fields: { cohort: `${SURNAME} 2026` },
    });
    expect(data.contact.tags.map((tag) => tag.name)).toEqual(["Course 101"]);
    expect(data.contact.lists).toEqual([
      expect.objectContaining({ listId: seeded.listId, status: "subscribed" }),
    ]);
    expect(data.suppression).toEqual({ suppressed: false, reason: null, since: null });
    expect(data.consentEvents.map((event) => event.basis)).toEqual([
      "existing_customer",
      "explicit_opt_in",
    ]);
    expect(data.consentEvents[1]?.note).toBe(`Ticked the box at the ${SURNAME} fair.`);
    expect(data.campaigns).toEqual([
      expect.objectContaining({
        campaignId: sent.campaignId,
        status: "sent",
        sentAt: T0,
        openedAt: T0 + 60_000,
        clickedAt: T0 + 120_000,
      }),
    ]);
    expect(data.events.map((event) => [event.type, event.url])).toEqual([
      ["open", null],
      ["click", "https://example.com/course"],
    ]);
    expect(data.providerEvents).toEqual([
      expect.objectContaining({ provider: "resend", type: "bounce_soft" }),
    ]);
    expect(data.truncated).toBe(false);

    // The audit log records the export, without the address.
    const audit = await run<{ items: { action: string; targetId: string; metadata: unknown }[] }>(
      owner,
      auditList,
      { action: "contacts.export" },
    );
    expect(audit.items).toEqual([
      expect.objectContaining({ targetId: String(contactId), metadata: { truncated: false } }),
    ]);
  });

  it("needs the contacts:export scope and is not available through MCP", async () => {
    const { seeded, contactId, run } = await setup();
    const reader = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read"],
      surface: "rest",
    });
    expect(await failure(run(reader, contactsExport, { id: contactId }))).toBe("forbidden");
    const agent = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:export"],
      surface: "mcp",
    });
    expect(await failure(run(agent, contactsExport, { id: contactId }))).toBe("forbidden");
  });
});

describe("contact erase", () => {
  it("leaves no plaintext address in any table or raw event, and keeps rollups and the suppression hash", async () => {
    const { db, services, seeded, sent, recipient, contactId, owner, run } = await setup();
    const markers = [EMAIL, SURNAME];
    expect((await plaintextHits(markers)).length).toBeGreaterThan(0);

    const result = await run<{ id: number; removed: Record<string, number> }>(
      owner,
      contactsErase,
      { id: contactId, confirm: EMAIL.toUpperCase() },
    );
    expect(result.id).toBe(contactId);
    expect(result.removed).toMatchObject({ events: 2, providerEvents: 1, recipients: 1 });

    expect(await plaintextHits(markers)).toEqual([]);

    const ws = seeded.workspaceId;
    expect(await failure(run(owner, contactsGet, { id: contactId }))).toBe("not_found");
    const recipientRow = await db.db
      .selectFrom("campaign_recipients")
      .selectAll()
      .where("workspace_id", "=", ws)
      .where("id", "=", recipient.id)
      .executeTakeFirstOrThrow();
    expect(recipientRow).toMatchObject({
      contact_id: null,
      provider_message_id: null,
      error: null,
      status: "sent",
    });
    const events = await db.db
      .selectFrom("email_events")
      .select("id")
      .where("workspace_id", "=", ws)
      .where("recipient_id", "=", recipient.id)
      .execute();
    expect(events).toEqual([]);

    // Rollups keep the counts of the campaign.
    const daily = await db.db
      .selectFrom("campaign_stats_daily")
      .select(["sent", "unique_opens", "unique_clicks"])
      .where("workspace_id", "=", ws)
      .where("campaign_id", "=", sent.campaignId)
      .executeTakeFirstOrThrow();
    expect(daily).toEqual({ sent: 3, unique_opens: 1, unique_clicks: 1 });

    // The keyed hash stays, with the reason `erased`.
    const suppression = await db.db
      .selectFrom("suppressions")
      .select(["reason", "source"])
      .where("workspace_id", "=", ws)
      .where("email_hash", "=", await services.hashEmail(EMAIL))
      .executeTakeFirstOrThrow();
    expect(suppression).toEqual({ reason: "erased", source: "erased:ui" });

    // The audit log keeps the actions with the contact id, and no address.
    const audit = await run<{
      items: { action: string; targetId: string | null; metadata: unknown }[];
    }>(owner, auditList, { limit: 100 });
    const erase = audit.items.find((item) => item.action === "contacts.erase");
    expect(erase).toMatchObject({ targetId: String(contactId), metadata: { erased: true } });
    const upsert = audit.items.find((item) => item.action === "contacts.upsert");
    expect(upsert).toMatchObject({ targetId: String(contactId), metadata: null });
  });

  it("keeps a re-import and an upsert of the address suppressed", async () => {
    const { db, services, seeded, contactId, owner, run } = await setup();
    await run(owner, contactsErase, { id: contactId, confirm: EMAIL });

    const upload = await run<{ id: number }>(owner, importsCreate, {
      filename: "students.csv",
      content: `email,first_name\r\n${EMAIL},Zelda\r\nnew.student@example.net,New\r\n`,
    });
    await run(owner, importsPreview, {
      id: upload.id,
      mapping: ["email", "first_name"],
      consentBasis: "existing_customer",
      listIds: [seeded.listId],
    });
    await runImportJob({ db, services }, services.jobs.at(-1) as ImportJob);
    await run(owner, importsStart, { id: upload.id });
    await runImportJob({ db, services }, services.jobs.at(-1) as ImportJob);
    const done = await run<{ status: string; counts: Record<string, number> }>(owner, importsGet, {
      id: upload.id,
    });
    expect(done.status).toBe("completed");
    expect(done.counts).toMatchObject({ new: 1, skippedSuppressed: 1 });

    // An API upsert can create the contact again, but it stays suppressed.
    const upserted = await run<{ contact: { status: string; suppressionReason: string } }>(
      owner,
      contactsUpsert,
      { email: EMAIL },
    );
    expect(upserted.contact).toMatchObject({ status: "suppressed", suppressionReason: "erased" });
  });

  it("needs the typed address, the contacts:delete scope, and a surface other than MCP", async () => {
    const { seeded, contactId, owner, run } = await setup();
    expect(await failure(run(owner, contactsErase, { id: contactId, confirm: "wrong" }))).toBe(
      "invalid_input",
    );
    const writer = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:write", "contacts:read"],
      surface: "rest",
    });
    expect(await failure(run(writer, contactsErase, { id: contactId, confirm: EMAIL }))).toBe(
      "forbidden",
    );
    const agent = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:delete"],
      surface: "mcp",
    });
    expect(await failure(run(agent, contactsErase, { id: contactId, confirm: EMAIL }))).toBe(
      "forbidden",
    );
    // The contact is still there.
    const contact = await run<{ email: string }>(owner, contactsGet, { id: contactId });
    expect(contact.email).toBe(EMAIL);
  });
});
