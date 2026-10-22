import type { DbConnection } from "@envelopen/db";
import { createTokenSigner, type TokenSigner } from "@envelopen/email-render";
import { describe, expect, it } from "vitest";
import { seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { TEST_SIGNING_KEY, type TestServices, testDb, testServices } from "../../test/fixtures";
import { createProviderMock, type ProviderMock } from "../../test/provider-mock";
import { brandUpdate } from "../brand/operations";
import { contactsUpsert } from "../contacts/operations";
import { isOperationError } from "../errors";
import {
  applyUnsubscribeIntent,
  loadSubscription,
  recipientTargets,
  resubscribe,
  unsubscribeAll,
} from "../events/subscription";
import { runOperation } from "../executor";
import { confirmSignup } from "../forms/confirm";
import { formsCreate } from "../forms/operations";
import { loadPublicForm, type SignupDeps, submitSignup } from "../forms/signup";
import { contactsErase } from "../gdpr/operations";
import { importsCreate, importsPreview, importsStart } from "../import/operations";
import { runImportJob } from "../import/process";
import { listsAddContacts, listsCreate } from "../lists/operations";
import { apiKeyPrincipal } from "../principal";
import type { ImportJob } from "../services";
import { suppressionsAdd } from "../suppression/operations";
import { startableJobs } from "./eligibility";
import { WELCOME_TOKEN_CAMPAIGN, type WelcomeJob, welcomeSendIdOf } from "./model";
import {
  welcomeSeriesCreate,
  welcomeSeriesGet,
  welcomeSeriesOverlaps,
  welcomeSeriesSetEnabled,
  welcomeSeriesUpdate,
} from "./operations";
import {
  planStep,
  runWelcomeStep,
  type StepOutcome,
  WelcomeRetryError,
  type WelcomeStepDeps,
} from "./run";

// Welcome series (U10, F2, AE3, KTD8). The provider mock stands in for the workspace's
// connection. `runSeries` drives the steps as the Workflow does, without the sleeps, and
// with a few retries for a refusal.

const T0 = Date.UTC(2026, 9, 21, 9);

interface Series {
  id: number;
  listId: number;
  enabled: boolean;
  entered: number;
  steps: { templateId: number; subject: string; delayMinutes: number }[];
  stats: { position: number; sent: number; failed: number; skipped: number; pending: number }[];
  overlaps: { seriesId: number; listId: number; sharedContacts: number }[];
}

interface Flags {
  limited: boolean;
  unsubscribesPending: boolean;
  pending: Set<number>;
  budget: "ok" | "defer";
}

async function setup(stepCount = 5) {
  const db = testDb();
  const mock = createProviderMock();
  const services = await testServices({ fetch: mock.fetch });
  const seeded = await seedCampaignWorkspace(db, services, {
    html:
      '<html><body><p>Hi {{ first_name | default: "there" }}, your cohort is {{ cohort | default: "open" }}.</p>' +
      '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>',
  });
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = T0) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => now }) as Promise<T>;
  const steps = Array.from({ length: stepCount }, (_, index) => ({
    templateId: seeded.templateId,
    subject: `Step ${index + 1} for {{ first_name | default: "you" }}`,
    delayMinutes: index === 0 ? 0 : 60 * 24,
  }));
  const created = await run<Series>(welcomeSeriesCreate, {
    listId: seeded.listId,
    name: "Welcome",
    steps,
  });
  const series = await run<Series>(welcomeSeriesSetEnabled, { id: created.id, enabled: true });
  const signer = await createTokenSigner([{ secret: TEST_SIGNING_KEY }]);
  const flags: Flags = {
    limited: false,
    unsubscribesPending: false,
    pending: new Set(),
    budget: "ok",
  };
  const stepDeps: WelcomeStepDeps = {
    db,
    services,
    signer,
    usage: async () => ({ limited: flags.limited, unsubscribesPending: flags.unsubscribesPending }),
    pendingUnsubscribes: async (_workspaceId, ids) =>
      new Set(ids.filter((id) => flags.pending.has(id))),
    budget: async () => flags.budget,
    now: () => T0,
  };
  const addContact = async (email: string, startWelcome = true, firstName = "Ana") => {
    const result = await run<{ contact: { id: number }; welcomeStarted: number }>(contactsUpsert, {
      email,
      firstName,
      consentBasis: "explicit_opt_in",
      listIds: [seeded.listId],
      startWelcome,
    });
    return result;
  };
  return { db, mock, services, seeded, run, series, signer, flags, stepDeps, addContact };
}

/** One step as the Workflow runs it: retries a refusal up to `retries` times. */
async function step(
  deps: WelcomeStepDeps,
  job: WelcomeJob,
  position: number,
  retries = 2,
): Promise<StepOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runWelcomeStep(deps, job, position);
    } catch (error) {
      if (!(error instanceof WelcomeRetryError) || attempt >= retries) {
        return { kind: "failed", sendId: null, error: String(error) };
      }
    }
  }
}

/** Every step of the series, as the Workflow runs them, with a hook after each one. */
async function runSeries(
  deps: WelcomeStepDeps,
  job: WelcomeJob,
  after: (position: number, outcome: StepOutcome) => Promise<void> = async () => {},
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (let position = 1; position <= 5; position++) {
    const plan = await planStep(deps.db, job, position);
    if (plan.kind === "end") break;
    const outcome = await step(deps, job, position);
    outcomes.push(outcome);
    await after(position, outcome);
    if (outcome.kind === "stopped" || outcome.kind === "end") break;
  }
  return outcomes;
}

interface SentEmail {
  to: string | string[];
  subject: string;
  html: string;
  headers?: Record<string, string>;
}

function emails(mock: ProviderMock): SentEmail[] {
  return mock.calls.flatMap((call) => {
    const body = JSON.parse(call.body || "null") as SentEmail | SentEmail[];
    return Array.isArray(body) ? body : [body];
  });
}

async function sendRows(db: DbConnection, workspaceId: number, contactId: number) {
  return db.db
    .selectFrom("welcome_sends")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("contact_id", "=", contactId)
    .orderBy("position")
    .execute();
}

function jobOf(services: TestServices, contactId: number): WelcomeJob {
  const job = services.welcomeStarts.find((item) => item.contactId === contactId);
  if (!job) throw new Error(`No welcome start for contact ${contactId}.`);
  return job;
}

/** The unsubscribe token in the List-Unsubscribe header of an email. */
async function tokenRef(signer: TokenSigner, email: SentEmail) {
  const header = email.headers?.["List-Unsubscribe"] ?? "";
  const token = /\/u\/([^>]+)>/.exec(header)?.[1] ?? "";
  const ref = await signer.verify(token);
  if (!ref) throw new Error("The unsubscribe token did not verify.");
  return ref;
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

describe("welcome series runs (F2, KTD8)", () => {
  it("covers F2: a confirmed signup gets step 1 after its delay, then step 2 after its delay", async () => {
    const { db, mock, services, seeded, run, signer, stepDeps } = await setup(2);
    const form = await run<{ publicId: string }>(formsCreate, {
      name: "Course news",
      listIds: [seeded.listId],
      enabled: true,
    });
    const loaded = await loadPublicForm(db, form.publicId);
    if (!loaded) throw new Error("The form did not load.");
    const signupDeps: SignupDeps = {
      db,
      services,
      now: T0,
      limiter: { record: async () => ({ count: 1 }) },
      usage: async () => ({ limited: false, unsubscribesPending: false }),
      pendingUnsubscribes: async () => new Set(),
    };
    await submitSignup(signupDeps, loaded, {
      email: "reader@example.org",
      values: {},
      ipHash: null,
      userAgent: null,
      origin: "https://envelopen.test",
    });
    const token = /\/f\/confirm\/([A-Za-z0-9_-]{43})/.exec(mock.calls[0]?.body ?? "")?.[1] ?? "";
    mock.calls.length = 0;
    const confirmed = await confirmSignup(db, token, T0 + 1000, services);
    if (confirmed.kind !== "confirmed") throw new Error("The signup did not confirm.");
    const job = jobOf(services, confirmed.contactId);
    expect(job).toEqual({
      workspaceId: seeded.workspaceId,
      seriesId: expect.any(Number),
      contactId: confirmed.contactId,
    });
    const series = await run<Series>(welcomeSeriesGet, { id: job.seriesId });
    expect(series.entered).toBe(1);

    // The Workflow reads each delay when the step is next.
    expect(await planStep(db, job, 1)).toEqual({ kind: "step", delayMinutes: 0 });
    expect(await planStep(db, job, 2)).toEqual({ kind: "step", delayMinutes: 1440 });
    expect(await planStep(db, job, 3)).toEqual({ kind: "end" });
    const outcomes = await runSeries(stepDeps, job);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["sent", "sent"]);
    const sent = emails(mock);
    expect(sent.map((email) => email.subject)).toEqual(["Step 1 for you", "Step 2 for you"]);
    expect(sent[0]?.html).toContain("Hi there, your cohort is open.");
    // Marketing email to a list: both RFC 8058 headers, with no open pixel and no tracked link.
    expect(sent[0]?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/envelopen\.test\/u\//);
    expect(sent[0]?.html).not.toContain("/t/o/");
    const rows = await sendRows(db, seeded.workspaceId, confirmed.contactId);
    expect(rows.map((row) => [row.position, row.status])).toEqual([
      [1, "sent"],
      [2, "sent"],
    ]);
    expect(rows[0]?.provider_message_id).toMatch(/^msg-/);
    // The token of the email names the send row, and resolves to the contact.
    const ref = await tokenRef(signer, sent[0] as SentEmail);
    expect(ref.campaignId).toBe(WELCOME_TOKEN_CAMPAIGN);
    expect(welcomeSendIdOf(ref)).toBe(rows[0]?.id);
    const sub = await loadSubscription(db, ref);
    expect(sub).toMatchObject({ workspaceId: seeded.workspaceId, contactId: confirmed.contactId });

    // A second confirmation starts nothing.
    await confirmSignup(db, token, T0 + 2000, services);
    expect(services.welcomeStarts.filter((item) => item.contactId === job.contactId)).toHaveLength(
      1,
    );
  });

  it("covers AE3: an unsubscribe at step 2 stops steps 3 to 5", async () => {
    const { db, mock, services, seeded, signer, stepDeps, addContact } = await setup(5);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    const outcomes = await runSeries(stepDeps, job, async (position) => {
      if (position !== 2) return;
      // The subscriber uses the one-click link of the step 2 email.
      const sub = await loadSubscription(db, await tokenRef(signer, emails(mock)[1] as SentEmail));
      if (!sub) throw new Error("No subscription for the token.");
      expect(await unsubscribeAll(db, sub, "one_click", T0 + 5000)).toBe(true);
    });
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["sent", "sent", "stopped"]);
    expect(outcomes[2]).toEqual({ kind: "stopped", reason: "unsubscribed" });
    expect(mock.delivered).toEqual(["ana@example.org", "ana@example.org"]);
    const rows = await sendRows(db, seeded.workspaceId, contact.id);
    expect(rows.map((row) => [row.position, row.status, row.skip_reason])).toEqual([
      [1, "sent", null],
      [2, "sent", null],
      [3, "skipped", "unsubscribed"],
    ]);
    // A welcome unsubscribe stores no campaign.
    const stored = await db.db
      .selectFrom("contacts")
      .select(["unsubscribed_at", "unsubscribe_campaign_id", "unsubscribe_source"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", contact.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      unsubscribed_at: T0 + 5000,
      unsubscribe_campaign_id: null,
      unsubscribe_source: "one_click",
    });
    // The step stays stopped on a later run.
    expect(await runWelcomeStep(stepDeps, job, 3)).toEqual({
      kind: "stopped",
      reason: "unsubscribed",
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("does not send twice when a step runs again after the provider accepted it", async () => {
    const { db, mock, services, seeded, stepDeps, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    const first = await runWelcomeStep(stepDeps, job, 1);
    expect(first).toMatchObject({ kind: "sent", uncertain: false });
    const again = await runWelcomeStep(stepDeps, job, 1);
    expect(again).toEqual(first);
    expect(mock.calls).toHaveLength(1);
    const [row] = await sendRows(db, seeded.workspaceId, contact.id);
    expect(row?.attempts).toBe(1);
  });

  it("fills the brand tokens from the live brand at each send (U13)", async () => {
    const { db, mock, services, seeded, run, stepDeps, addContact } = await setup(2);
    await db.db
      .updateTable("templates")
      .set({
        html:
          '<html><body><p style="color:{{ brand.color_primary }}">{{ brand.name }}</p>' +
          '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>',
      })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.templateId)
      .execute();
    const brand = (colorPrimary: string, name: string) => ({
      name,
      colorPrimary,
      colorAccent: "#ffffff",
      font: "system",
      footer: "",
      address: "1 Course Street",
      social: {},
    });
    await run(brandUpdate, brand("#112233", "Acme"));
    const { contact } = await addContact("brand@example.org");
    const job = jobOf(services, contact.id);
    await runWelcomeStep(stepDeps, job, 1);
    await run(brandUpdate, brand("#445566", "Acme Two"));
    await runWelcomeStep(stepDeps, job, 2);
    const [first, second] = emails(mock);
    expect(first?.html).toContain('<p style="color:#112233">Acme</p>');
    expect(second?.html).toContain('<p style="color:#445566">Acme Two</p>');
    expect(mock.calls).toHaveLength(2);
  });

  it("treats a pending row with no result as sent", async () => {
    const { db, mock, services, seeded, stepDeps, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    // A 5xx: the provider may have accepted the email.
    mock.respond = () => new Response("upstream error", { status: 502 });
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent", uncertain: true });
    mock.respond = undefined;
    const [row] = await sendRows(db, seeded.workspaceId, contact.id);
    expect(row?.status).toBe("pending");
    // The retry sends nothing, and step 2 goes on.
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent", uncertain: true });
    expect(await runWelcomeStep(stepDeps, job, 2)).toMatchObject({
      kind: "sent",
      uncertain: false,
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("retries a provider refusal, then records the step as failed without blocking the next step", async () => {
    const { db, mock, services, seeded, stepDeps, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    // A refusal, then success: the retry sends.
    mock.respond = (_call, index) =>
      index === 0
        ? new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })
        : undefined;
    await expect(runWelcomeStep(stepDeps, job, 1)).rejects.toBeInstanceOf(WelcomeRetryError);
    let [row] = await sendRows(db, seeded.workspaceId, contact.id);
    expect(row?.status).toBe("failed");
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent" });
    [row] = await sendRows(db, seeded.workspaceId, contact.id);
    expect(row).toMatchObject({ status: "sent", attempts: 2, error: null });

    // A refusal on every try: the step fails after the retries, and step 2 still sends.
    const other = await addContact("bo@example.org", true, "Bo");
    const otherJob = jobOf(services, other.contact.id);
    mock.calls.length = 0;
    mock.respond = (call) =>
      call.body.includes("Step 1")
        ? new Response(JSON.stringify({ message: "Quota exceeded" }), { status: 429 })
        : undefined;
    const outcomes = await runSeries(stepDeps, otherJob);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["failed", "sent"]);
    // The first try and two retries.
    expect(mock.calls.filter((call) => call.body.includes("Step 1"))).toHaveLength(3);
    const rows = await sendRows(db, seeded.workspaceId, other.contact.id);
    expect(rows.map((item) => [item.position, item.status, item.attempts])).toEqual([
      [1, "failed", 3],
      [2, "sent", 1],
    ]);
    expect(rows[0]?.error).toContain("Quota");
  });

  it("sends no step to a contact with an unsubscribe in the ledger after the reset and before the drain", async () => {
    const { db, mock, services, seeded, stepDeps, flags, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    // D1 works again, and the ledger still holds the contact's one-click unsubscribe.
    flags.unsubscribesPending = true;
    flags.pending.add(contact.id);
    expect(await runWelcomeStep(stepDeps, job, 1)).toEqual({
      kind: "stopped",
      reason: "unsubscribe_pending",
    });
    expect(mock.calls).toHaveLength(0);
    const [row] = await sendRows(db, seeded.workspaceId, contact.id);
    expect(row).toMatchObject({ status: "skipped", skip_reason: "unsubscribe_pending" });
  });

  it("waits at the D1 limit and when the budget hook defers", async () => {
    const { mock, services, stepDeps, flags, addContact } = await setup(1);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    flags.limited = true;
    expect(await runWelcomeStep(stepDeps, job, 1)).toEqual({
      kind: "defer",
      until: Date.UTC(2026, 9, 22),
      reason: "platform_limit",
    });
    flags.limited = false;
    flags.budget = "defer";
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({
      kind: "defer",
      reason: "budget",
    });
    flags.budget = "ok";
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent" });
    expect(mock.calls).toHaveLength(1);
  });

  it("waits for the daily cap that campaigns share, then sends (U19)", async () => {
    const { db, mock, services, seeded, stepDeps, addContact } = await setup(1);
    await db.db
      .updateTable("provider_connections")
      .set({ daily_cap: 2 })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.connectionId)
      .execute();
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    // A campaign batch used the whole cap an hour ago.
    services.dailyClock.now = T0 - 60 * 60 * 1000;
    await services.dailyCounter.reserve(seeded.connectionId, 2, 2);
    services.dailyClock.now = T0;
    const deps = { ...stepDeps, dailyCounter: services.dailyCounter };
    expect(await runWelcomeStep(deps, job, 1)).toEqual({
      kind: "defer",
      until: T0 - 60 * 60 * 1000 + 24 * 60 * 60 * 1000,
      reason: "daily_cap",
    });
    expect(mock.calls).toHaveLength(0);
    expect(await sendRows(db, seeded.workspaceId, contact.id)).toEqual([]);
    // After the campaign's sends age out, the step sends and takes one message.
    services.dailyClock.now = T0 + 24 * 60 * 60 * 1000;
    expect(await runWelcomeStep(deps, job, 1)).toMatchObject({ kind: "sent" });
    expect(mock.calls).toHaveLength(1);
    expect(await services.dailyCounter.used(seeded.connectionId)).toBe(1);
  });

  it("gives the daily reservation back when the provider refuses the welcome email (U19)", async () => {
    const { db, mock, services, seeded, stepDeps, addContact } = await setup(1);
    await db.db
      .updateTable("provider_connections")
      .set({ daily_cap: 5 })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.connectionId)
      .execute();
    const { contact } = await addContact("ana@example.org");
    services.dailyClock.now = T0;
    mock.respond = () =>
      new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Slow down" }), {
        status: 429,
      });
    await expect(
      runWelcomeStep(
        { ...stepDeps, dailyCounter: services.dailyCounter },
        jobOf(services, contact.id),
        1,
      ),
    ).rejects.toThrow(WelcomeRetryError);
    expect(await services.dailyCounter.used(seeded.connectionId)).toBe(0);
  });

  it("stops at the next check when the owner turns the series off, and an edit applies to the steps not run", async () => {
    const { db, mock, services, seeded, run, series, stepDeps, addContact } = await setup(3);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent" });
    await run(welcomeSeriesUpdate, {
      id: series.id,
      name: "Welcome",
      steps: [
        { templateId: seeded.templateId, subject: "New step 1", delayMinutes: 0 },
        { templateId: seeded.templateId, subject: "New step 2", delayMinutes: 5 },
      ],
    });
    expect(await planStep(db, job, 2)).toEqual({ kind: "step", delayMinutes: 5 });
    expect(await planStep(db, job, 3)).toEqual({ kind: "end" });
    expect(await runWelcomeStep(stepDeps, job, 2)).toMatchObject({ kind: "sent" });
    expect(emails(mock).map((email) => email.subject)).toEqual(["Step 1 for Ana", "New step 2"]);

    const other = await addContact("bo@example.org", true, "Bo");
    await run(welcomeSeriesSetEnabled, { id: series.id, enabled: false });
    expect(await runWelcomeStep(stepDeps, jobOf(services, other.contact.id), 1)).toEqual({
      kind: "stopped",
      reason: "series_disabled",
    });
    // No new start while the series is off.
    const third = await addContact("cy@example.org", true, "Cy");
    expect(third.welcomeStarted).toBe(0);
    expect(mock.calls).toHaveLength(2);
  });

  it("stops for a suppressed address and for a contact who left the list", async () => {
    const { db, mock, services, seeded, run, stepDeps, addContact } = await setup(2);
    const ana = await addContact("ana@example.org");
    const bo = await addContact("bo@example.org", true, "Bo");
    await run(suppressionsAdd, { emails: ["ana@example.org"] });
    expect(services.welcomeStops).toContainEqual(jobOf(services, ana.contact.id));
    expect(await runWelcomeStep(stepDeps, jobOf(services, ana.contact.id), 1)).toEqual({
      kind: "stopped",
      reason: "suppressed",
    });
    await db.db
      .deleteFrom("list_members")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", bo.contact.id)
      .execute();
    expect(await runWelcomeStep(stepDeps, jobOf(services, bo.contact.id), 1)).toEqual({
      kind: "stopped",
      reason: "left_list",
    });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("welcome series starts", () => {
  it("starts on an API list add with startWelcome, and starts nothing without it", async () => {
    const { db, services, seeded, addContact } = await setup(1);
    const plain = await addContact("plain@example.org", false);
    expect(plain.welcomeStarted).toBe(0);
    expect(services.welcomeStarts).toHaveLength(0);
    const key = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:write"],
      surface: "rest",
    });
    const viaKey = (input: unknown) =>
      runOperation(key, listsAddContacts, input, { db, services, now: () => T0 }) as Promise<{
        welcomeStarted: number;
      }>;
    expect(await viaKey({ id: seeded.listId, contactIds: [plain.contact.id] })).toMatchObject({
      welcomeStarted: 0,
    });
    expect(services.welcomeStarts).toHaveLength(0);
    expect(
      await viaKey({ id: seeded.listId, contactIds: [plain.contact.id], startWelcome: true }),
    ).toMatchObject({ welcomeStarted: 1 });
    expect(services.welcomeStarts.map((job) => job.contactId)).toEqual([plain.contact.id]);
    // The same add again: the instance exists, so nothing new starts.
    expect(
      await viaKey({ id: seeded.listId, contactIds: [plain.contact.id], startWelcome: true }),
    ).toMatchObject({ welcomeStarted: 0 });
  });

  it("does not start again on a resubscribe", async () => {
    const { db, mock, services, seeded, signer, stepDeps, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    expect(await runWelcomeStep(stepDeps, job, 1)).toMatchObject({ kind: "sent" });
    const sub = await loadSubscription(db, await tokenRef(signer, emails(mock)[0] as SentEmail));
    if (!sub) throw new Error("No subscription for the token.");
    await unsubscribeAll(db, sub, "preference_page", T0 + 1000);
    const again = await loadSubscription(db, await tokenRef(signer, emails(mock)[0] as SentEmail));
    if (!again) throw new Error("No subscription for the token.");
    expect(await resubscribe(db, again, T0 + 2000)).toBe(true);
    // The Workflow can forget an instance id after its retention, so the rows decide.
    expect(await startableJobs(db, seeded.workspaceId, [contact.id], [seeded.listId])).toEqual([]);
    const fresh = await testServices({ fetch: mock.fetch });
    const result = await runOperation(
      seeded.principal,
      listsAddContacts,
      { id: seeded.listId, contactIds: [contact.id], startWelcome: true },
      { db, services: fresh, now: () => T0 + 3000 },
    );
    expect(result).toMatchObject({ welcomeStarted: 0 });
    expect(fresh.welcomeStarts).toHaveLength(0);
  });

  it("starts nothing for an import into the list", async () => {
    const { db, services, seeded, run } = await setup(1);
    const upload = await run<{ id: number }>(importsCreate, {
      filename: "students.csv",
      content: "email,first_name\r\nimported@example.org,Imp\r\n",
    });
    const config = {
      id: upload.id,
      mapping: ["email", "first_name"],
      consentBasis: "explicit_opt_in",
      listIds: [seeded.listId],
    };
    await run(importsPreview, config);
    await runImportJob({ db, services }, services.jobs.at(-1) as ImportJob);
    await run(importsStart, { id: upload.id });
    await runImportJob({ db, services }, services.jobs.at(-1) as ImportJob);
    const member = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "imported@example.org")
      .executeTakeFirst();
    expect(member).toBeDefined();
    expect(services.welcomeStarts).toHaveLength(0);
  });

  it("gives a contact on two lists both series, and reports the overlap", async () => {
    const { db, services, seeded, run, addContact } = await setup(1);
    const second = await run<{ id: number }>(listsCreate, { name: "Alumni" });
    const other = await run<Series>(welcomeSeriesCreate, {
      listId: second.id,
      name: "Alumni welcome",
      steps: [{ templateId: seeded.templateId, subject: "Hello again", delayMinutes: 0 }],
    });
    await run(welcomeSeriesSetEnabled, { id: other.id, enabled: true });
    const result = await run<{ contact: { id: number }; welcomeStarted: number }>(contactsUpsert, {
      email: "both@example.org",
      listIds: [seeded.listId, second.id],
      startWelcome: true,
    });
    expect(result.welcomeStarted).toBe(2);
    await addContact("one@example.org");
    const overlaps = await run<{ items: Series["overlaps"] }>(welcomeSeriesOverlaps, {
      listId: seeded.listId,
    });
    expect(overlaps.items).toEqual([
      { seriesId: other.id, listId: second.id, listName: "Alumni", sharedContacts: 1 },
    ]);
    const shown = await run<Series>(welcomeSeriesGet, { id: other.id });
    expect(shown.overlaps).toMatchObject([{ listId: seeded.listId, sharedContacts: 1 }]);
    expect(
      services.welcomeStarts.filter((job) => job.contactId === result.contact.id),
    ).toHaveLength(2);
    void db;
  });
});

describe("welcome series erase and unsubscribe links", () => {
  it("terminates the instances on erase and removes the contact's send rows", async () => {
    const { db, services, seeded, run, stepDeps, addContact } = await setup(2);
    const { contact } = await addContact("ana@example.org");
    const job = jobOf(services, contact.id);
    await runWelcomeStep(stepDeps, job, 1);
    expect(await sendRows(db, seeded.workspaceId, contact.id)).toHaveLength(1);
    await run(contactsErase, { id: contact.id, confirm: "ana@example.org" });
    expect(services.welcomeStops).toContainEqual(job);
    const left = await db.db
      .selectFrom("welcome_sends")
      .select("id")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("series_id", "=", job.seriesId)
      .execute();
    expect(left).toEqual([]);
    // A step that runs after the erase finds no contact and sends nothing.
    expect(await runWelcomeStep(stepDeps, job, 2)).toEqual({
      kind: "stopped",
      reason: "contact_missing",
    });
  });

  it("applies a ledger intent of a welcome email with no campaign, and finds its contact", async () => {
    const { db, mock, services, seeded, signer, stepDeps, addContact } = await setup(1);
    const { contact } = await addContact("ana@example.org");
    await runWelcomeStep(stepDeps, jobOf(services, contact.id), 1);
    const ref = await tokenRef(signer, emails(mock)[0] as SentEmail);
    const targets = await recipientTargets(db, [ref]);
    expect(targets.get(ref.recipientId)).toEqual({
      workspaceId: seeded.workspaceId,
      contactId: contact.id,
    });
    const changed = await applyUnsubscribeIntent(
      db,
      {
        workspaceId: seeded.workspaceId,
        contactId: contact.id,
        campaignId: ref.campaignId,
        listId: null,
        source: "one_click",
        at: T0 + 10,
      },
      T0 + 20,
    );
    expect(changed).toBe(true);
    const member = await db.db
      .selectFrom("list_members")
      .select(["status", "status_campaign_id"])
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", contact.id)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ status: "unsubscribed", status_campaign_id: null });
  });
});

describe("welcome series operations", () => {
  it("checks steps, the sender, and the provider policy", async () => {
    const { seeded, run, series } = await setup(1);
    expect(series.enabled).toBe(true);
    expect(
      await failure(
        run(welcomeSeriesCreate, {
          listId: seeded.listId,
          name: "Second",
          steps: [{ templateId: seeded.templateId, subject: "Hi", delayMinutes: 0 }],
        }),
      ),
    ).toBe("conflict");
    const list = await run<{ id: number }>(listsCreate, { name: "Other" });
    const base = { listId: list.id, name: "Other" };
    const step = { templateId: seeded.templateId, subject: "Hi", delayMinutes: 0 };
    expect(await failure(run(welcomeSeriesCreate, { ...base, steps: [] }))).toBe("invalid_input");
    expect(await failure(run(welcomeSeriesCreate, { ...base, steps: Array(6).fill(step) }))).toBe(
      "invalid_input",
    );
    expect(
      await failure(
        run(welcomeSeriesCreate, { ...base, steps: [{ ...step, delayMinutes: 43_201 }] }),
      ),
    ).toBe("invalid_input");
    expect(
      await failure(
        run(welcomeSeriesCreate, { ...base, steps: [{ ...step, templateId: 999_999 }] }),
      ),
    ).toBe("not_found");
    expect(
      await failure(
        run(welcomeSeriesCreate, { ...base, steps: [step], fromEmail: "me@elsewhere.example" }),
      ),
    ).toBe("invalid_input");
    const created = await run<Series>(welcomeSeriesCreate, {
      ...base,
      steps: [step],
      fromEmail: "Hello@Mail.Example.com",
    });
    expect(created).toMatchObject({ enabled: false, fromEmail: "hello@mail.example.com" });
  });

  it("refuses to turn a series on through a transactional-only connection without the accepted warning", async () => {
    const { db, seeded, run } = await setup(1);
    await db.db
      .updateTable("provider_connections")
      .set({ policy: "transactional-only", policy_warning_accepted_at: null })
      .where("workspace_id", "=", seeded.workspaceId)
      .execute();
    const list = await run<{ id: number }>(listsCreate, { name: "Other" });
    const created = await run<Series>(welcomeSeriesCreate, {
      listId: list.id,
      name: "Other",
      steps: [{ templateId: seeded.templateId, subject: "Hi", delayMinutes: 0 }],
    });
    expect(await failure(run(welcomeSeriesSetEnabled, { id: created.id, enabled: true }))).toBe(
      "conflict",
    );
  });
});
