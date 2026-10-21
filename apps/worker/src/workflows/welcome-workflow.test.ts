import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type WelcomeJob, welcomeInstanceId } from "@envelopen/core";
import { addContacts, seedCampaignWorkspace } from "@envelopen/core/testing/campaign-fixtures";
import { createProviderMock, type ProviderMock } from "@envelopen/core/testing/provider-mock";
import type { DbConnection } from "@envelopen/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campaignDb, testKeys } from "../../test/campaign-helpers";
import { welcomeRunner } from "../services";

// The welcome series Workflow end to end, in the local runtime (U10, F2, AE3). The
// sleeps and the retry delays are off, so a run takes milliseconds. The outbound fetch
// of the step goes to a provider mock.

let mock: ProviderMock;

beforeEach(() => {
  mock = createProviderMock();
  vi.spyOn(globalThis, "fetch").mockImplementation(mock.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed(subjects: string[], delayMinutes = 60) {
  const db = campaignDb();
  const keys = await testKeys();
  const seeded = await seedCampaignWorkspace(db, keys);
  const series = await db.db
    .insertInto("welcome_series")
    .values({
      workspace_id: seeded.workspaceId,
      list_id: seeded.listId,
      name: "Welcome",
      steps: JSON.stringify(
        subjects.map((subject) => ({ templateId: seeded.templateId, subject, delayMinutes })),
      ),
      from_name: "Course Academy",
      from_email: "hello@mail.example.com",
      reply_to: null,
      link_origin: "https://envelopen.test",
      enabled: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const [contactId] = await addContacts(db, keys.hashEmail, seeded.workspaceId, seeded.listId, 1, {
    prefix: `welcome-${crypto.randomUUID().slice(0, 8)}-`,
  });
  const job: WelcomeJob = {
    workspaceId: seeded.workspaceId,
    seriesId: series.id,
    contactId: contactId as number,
  };
  return { db, seeded, job };
}

/**
 * Starts the instance with the sleeps and retry delays off, and waits for its end.
 * Returns the output and what a second start of the same job gives.
 */
async function runToEnd(job: WelcomeJob): Promise<{ output: unknown; again: WelcomeJob[] }> {
  const id = welcomeInstanceId(job);
  const instance = await introspectWorkflowInstance(env.WELCOME_WORKFLOW, id);
  try {
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const started = await welcomeRunner(env).start([job]);
    expect(started).toEqual([job]);
    await instance.waitForStatus("complete");
    const output = await instance.getOutput();
    return { output, again: await welcomeRunner(env).start([job]) };
  } finally {
    await instance.dispose();
  }
}

async function rows(db: DbConnection, job: WelcomeJob) {
  return db.db
    .selectFrom("welcome_sends")
    .select(["position", "status", "skip_reason", "attempts"])
    .where("workspace_id", "=", job.workspaceId)
    .where("series_id", "=", job.seriesId)
    .where("contact_id", "=", job.contactId)
    .orderBy("position")
    .execute();
}

function subjects(): string[] {
  return mock.calls.flatMap((call) => {
    const body = JSON.parse(call.body || "null") as { subject: string } | { subject: string }[];
    return (Array.isArray(body) ? body : [body]).map((email) => email.subject);
  });
}

describe("welcome Workflow", () => {
  it("covers F2: sends step 1 after its delay and step 2 after its delay, once each", async () => {
    const { db, job } = await seed(["Welcome to the course", "Your first lesson"]);
    const { output, again } = await runToEnd(job);
    expect(output).toBe("done");
    // A second start of the same contact and series is a no-op.
    expect(again).toEqual([]);
    expect(subjects()).toEqual(["Welcome to the course", "Your first lesson"]);
    expect(await rows(db, job)).toEqual([
      { position: 1, status: "sent", skip_reason: null, attempts: 1 },
      { position: 2, status: "sent", skip_reason: null, attempts: 1 },
    ]);
  });

  it("covers AE3: an unsubscribe at step 2 stops steps 3 to 5", async () => {
    const { db, job } = await seed(["One", "Two", "Three", "Four", "Five"]);
    mock.respond = (_call, index) => {
      if (index !== 1) return undefined;
      // The provider accepts the step 2 email, and the contact unsubscribes right after.
      return db.db
        .updateTable("contacts")
        .set({ unsubscribed_at: Date.now(), unsubscribe_source: "one_click" })
        .where("workspace_id", "=", job.workspaceId)
        .where("id", "=", job.contactId)
        .execute()
        .then(() => Response.json({ data: [{ id: "msg-step-2" }] }));
    };
    expect((await runToEnd(job)).output).toBe("stopped: unsubscribed");
    expect(subjects()).toEqual(["One", "Two"]);
    expect(await rows(db, job)).toEqual([
      { position: 1, status: "sent", skip_reason: null, attempts: 1 },
      { position: 2, status: "sent", skip_reason: null, attempts: 1 },
      { position: 3, status: "skipped", skip_reason: "unsubscribed", attempts: 0 },
    ]);
  });

  it("retries a provider refusal with backoff, then records the step as failed and sends the next step", async () => {
    const { db, job } = await seed(["Refused", "Next"]);
    mock.respond = (call) =>
      call.body.includes("Refused")
        ? new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })
        : undefined;
    expect((await runToEnd(job)).output).toBe("done");
    // The first try and 4 retries, then step 2.
    expect(subjects()).toEqual(["Refused", "Refused", "Refused", "Refused", "Refused", "Next"]);
    expect(await rows(db, job)).toEqual([
      { position: 1, status: "failed", skip_reason: null, attempts: 5 },
      { position: 2, status: "sent", skip_reason: null, attempts: 1 },
    ]);
  });

  it("stops a waiting instance when the runner terminates it", async () => {
    const { job } = await seed(["Later"], 60 * 24);
    const runner = welcomeRunner(env);
    expect(await runner.start([job])).toEqual([job]);
    const instance = await env.WELCOME_WORKFLOW.get(welcomeInstanceId(job));
    for (let i = 0; i < 50; i++) {
      const { status } = await instance.status();
      if (status === "waiting" || status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await runner.stop([job]);
    // A stop of an instance that is gone or ended is a no-op.
    await runner.stop([{ ...job, seriesId: job.seriesId + 1000 }]);
    let status = "";
    for (let i = 0; i < 50 && status !== "terminated"; i++) {
      status = (await instance.status()).status;
      if (status !== "terminated") await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe("terminated");
    expect(mock.calls).toHaveLength(0);
  });
});
