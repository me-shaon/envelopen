import { API_KEY_PRESETS, type CampaignJob, type Services } from "@envelopen/core";
import { seedCampaignWorkspace } from "@envelopen/core/testing/campaign-fixtures";
import type { CallToolResult, Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { processPointer } from "../src/queue/send-consumer";
import {
  campaignDb,
  campaignRow,
  recordingQueue,
  snapshot,
  testDeps,
  testKeys,
} from "./campaign-helpers";
import { createApiKey, ORIGIN } from "./helpers";
import { createMcpTestApp } from "./mcp-helpers";

// U16: an agent runs the first campaign (F1) through MCP only, with an "Agent sender"
// key. The provider is the in-process mock, so no email leaves the test. The send queue
// records the batch pointers, and the test hands them to the real send consumer.

type Json = Record<string, unknown>;

const TEST_ADDRESS = "qa@example.org";
const FROM = "news@mail.example.com";
const SENDER_SCOPES = [...API_KEY_PRESETS.agent_sender.scopes];

async function setup() {
  const db = campaignDb();
  const { credentials, hashEmail } = await testKeys();
  const seeded = await seedCampaignWorkspace(db, { credentials, hashEmail }, { contacts: 0 });
  await db.db
    .insertInto("test_addresses")
    .values({ workspace_id: seeded.workspaceId, email: TEST_ADDRESS })
    .execute();
  const deps = await testDeps(db);
  const queue = recordingQueue();
  const jobs: CampaignJob[] = [];
  const services: Partial<Services> = {
    credentials,
    hashEmail,
    outboundFetch: deps.mock.fetch,
    appOrigin: ORIGIN,
    sendQueue: queue,
    async startCampaignJob(job) {
      jobs.push(job);
    },
    usage: {
      async status() {
        return { day: "2026-10-19", rowsWritten: 0, dailyLimit: 100_000, platformLimit: null };
      },
    },
  };
  const app = createMcpTestApp({ services });
  return { db, seeded, deps, queue, jobs, app };
}

/** Calls a tool and returns its structured content. Fails the test on a tool error. */
async function use(client: Client, name: string, args: Json = {}): Promise<Json> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError)
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent as Json;
}

async function draftCampaign(client: Client, listId: number) {
  const template = await use(client, "templates_create", {
    name: "Course launch",
    subject: 'A new course for {{ first_name | default: "you" }}',
    format: "markdown",
    source:
      '# Hello {{ first_name | default: "there" }}\n\n' +
      "The [new course](https://example.com/course) starts next week.\n\n" +
      "[Unsubscribe]({{ unsubscribe_url }})",
    idempotencyKey: "template-1",
  });
  const campaign = await use(client, "campaigns_create", {
    name: "Course launch",
    templateId: template.id,
    fromName: "Ada",
    fromEmail: FROM,
    audience: { listIds: [listId] },
  });
  return { template, campaign };
}

describe("MCP flow (F1)", () => {
  it("upserts contacts, drafts from Markdown, test sends, prepares, confirms, and sends", async () => {
    const { db, seeded, deps, queue, jobs, app } = await setup();
    const { key, id: keyId } = await createApiKey(seeded.workspaceId, SENDER_SCOPES);
    const client = await app.connect(key);

    const context = await use(client, "get_workspace_context");
    expect(context.provider).toMatchObject({ ready: true });

    for (const email of ["ada@example.org", "grace@example.org"]) {
      const upserted = await use(client, "contacts_upsert", {
        email,
        firstName: email.split("@")[0],
        consentBasis: "explicit_opt_in",
        listIds: [seeded.listId],
      });
      expect(upserted.created).toBe(true);
    }

    const { template, campaign } = await draftCampaign(client, seeded.listId);
    expect(template.format).toBe("markdown");
    expect(campaign.status).toBe("draft");

    const test = await use(client, "campaigns_send_test", {
      to: [TEST_ADDRESS],
      from: FROM,
      templateId: template.id,
    });
    expect(test).toBeTruthy();
    expect(deps.mock.delivered).toEqual([TEST_ADDRESS]);

    const prepared = await use(client, "campaigns_prepare", {
      id: campaign.id,
      mode: "send_now",
    });
    expect(prepared.blocked).toBe(false);
    expect(prepared.estimate).toMatchObject({ recipients: 2, isEstimate: true });
    expect(typeof prepared.token).toBe("string");

    const confirmed = await use(client, "campaigns_confirm", {
      id: campaign.id,
      token: prepared.token,
    });
    expect(confirmed.status).toBe("sending");
    expect(jobs).toHaveLength(1);

    // The Workflow and the queue consumer, run in order as the platform would.
    const job = jobs[0] as CampaignJob;
    await snapshot(db, job, queue);
    deps.clock.now = Date.now() + 1000;
    for (const pointer of queue.sent) await processPointer(deps, pointer);
    const row = await campaignRow(db, seeded.workspaceId, campaign.id as number);
    expect(row.status).toBe("sent");
    expect([...deps.mock.delivered].sort()).toEqual(
      [TEST_ADDRESS, "ada@example.org", "grace@example.org"].sort(),
    );

    const stats = await use(client, "campaigns_stats", { id: campaign.id });
    expect(stats).toBeTruthy();

    // The audit log records the MCP surface and the key for every write. The consumer
    // adds its own system row when the campaign is sent.
    const rows = await db.db
      .selectFrom("audit_log")
      .select(["action", "surface", "actor_type", "actor_id", "api_key_id"])
      .where("workspace_id", "=", seeded.workspaceId)
      .orderBy("id")
      .execute();
    const audit = rows.filter((entry) => entry.surface !== "system");
    expect(rows.filter((entry) => entry.surface === "system").map((entry) => entry.action)).toEqual(
      ["campaigns.sent"],
    );
    expect(audit.map((entry) => entry.action)).toEqual([
      "contacts.upsert",
      "contacts.upsert",
      "templates.create",
      "campaigns.create",
      "campaigns.send_test",
      "campaigns.prepare",
      "campaigns.confirm",
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({
        surface: "mcp",
        actor_type: "api_key",
        actor_id: String(keyId),
        api_key_id: keyId,
      });
    }
  });

  it("rejects a confirm token that another key prepared", async () => {
    const { seeded, app } = await setup();
    const keyA = await createApiKey(seeded.workspaceId, SENDER_SCOPES);
    const keyB = await createApiKey(seeded.workspaceId, SENDER_SCOPES);
    const clientA = await app.connect(keyA.key);
    const clientB = await app.connect(keyB.key);
    await use(clientA, "contacts_upsert", {
      email: "ada@example.org",
      consentBasis: "explicit_opt_in",
      listIds: [seeded.listId],
    });
    const { campaign } = await draftCampaign(clientA, seeded.listId);
    const prepared = await use(clientA, "campaigns_prepare", {
      id: campaign.id,
      mode: "send_now",
    });

    const stolen = (await clientB.callTool({
      name: "campaigns_confirm",
      arguments: { id: campaign.id, token: prepared.token },
    })) as CallToolResult;
    expect(stolen.isError).toBe(true);
    expect(stolen.structuredContent).toMatchObject({
      error: { code: "forbidden", details: { reason: "actor" } },
    });

    // The token still works for the key that prepared it.
    const confirmed = await use(clientA, "campaigns_confirm", {
      id: campaign.id,
      token: prepared.token,
    });
    expect(confirmed.status).toBe("sending");
  });

  it("keeps the send tools away from an editor key", async () => {
    const { seeded, app } = await setup();
    const { key } = await createApiKey(seeded.workspaceId, [
      ...API_KEY_PRESETS.agent_editor.scopes,
    ]);
    const client = await app.connect(key);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("campaigns_send_test");
    expect(names).not.toContain("campaigns_prepare");
    expect(names).not.toContain("campaigns_confirm");
  });
});
