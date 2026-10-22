import type { DbConnection } from "@envelopen/db";
import { describe, expect, it } from "vitest";
import { createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { TEST_ORIGIN, testDb, testServices } from "../../test/fixtures";
import { createProviderMock, type ProviderMock } from "../../test/provider-mock";
import { estimateAudience } from "../campaigns/audience";
import { campaignAudience, loadCampaign } from "../campaigns/model";
import { campaignsConfirm, campaignsPrepare } from "../campaigns/operations";
import { beginSnapshot, snapshotPage } from "../campaigns/snapshot";
import { connectionsDailyUsage } from "../connections/operations";
import { fieldsCreate } from "../contacts/fields";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { apiKeyPrincipal } from "../principal";
import { confirmSignup, purgeExpiredSignups } from "./confirm";
import { normalizeEmbedOrigin, SIGNUP_TOKEN_TTL_MS } from "./model";
import { formsCreate, formsGet, formsList, formsUpdate } from "./operations";
import {
  type CountLimiter,
  loadPublicForm,
  type PublicForm,
  resendSignup,
  type SignupDeps,
  sendDeferredConfirmations,
  signupOfToken,
  submitSignup,
  validateSubmission,
} from "./signup";

// Signup forms with double opt-in (U8, F1, AE2, KTD7). The provider mock stands in for
// the workspace's connection, and an in-memory counter stands in for the limiter DO.

const T0 = Date.UTC(2026, 9, 21, 9);
const HOUR = 60 * 60 * 1000;

function memoryLimiter(): CountLimiter & { clock: number } {
  const windows = new Map<string, { start: number; count: number }>();
  const limiter = {
    clock: T0,
    async record(key: string, rule: { windowMs: number }) {
      const now = limiter.clock;
      const window = windows.get(key);
      if (!window || now - window.start >= rule.windowMs) {
        windows.set(key, { start: now, count: 1 });
        return { count: 1 };
      }
      window.count++;
      return { count: window.count };
    },
  };
  return limiter;
}

interface Form {
  id: number;
  publicId: string;
  consentVersion: number;
  listIds: number[];
  requiredFieldIds?: number[];
}

async function setup() {
  const db = testDb();
  const mock = createProviderMock();
  const services = await testServices({ fetch: mock.fetch });
  const seeded = await seedCampaignWorkspace(db, services, { contacts: 2 });
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = T0) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => now }) as Promise<T>;
  const field = await run<{ id: number; options: { id: number; label: string }[] }>(fieldsCreate, {
    key: `interests_${crypto.randomUUID().slice(0, 6)}`,
    label: "Interests",
    type: "multi",
    options: ["Design", "Data", "Writing"],
  });
  const form = await run<Form>(formsCreate, {
    name: "Course news",
    listIds: [seeded.listId],
    fieldIds: [field.id],
    consentText: "I agree to get the course news.",
    successMessage: "Welcome to the course news.",
    allowedOrigins: ["https://www.example.com"],
    enabled: true,
  });
  const limiter = memoryLimiter();
  const flags = { limited: false, unsubscribesPending: false, pending: new Set<number>() };
  const deps = (now = limiter.clock): SignupDeps => ({
    db,
    services,
    now,
    limiter,
    usage: async () => ({ limited: flags.limited, unsubscribesPending: flags.unsubscribesPending }),
    pendingUnsubscribes: async (_workspaceId, ids) =>
      new Set(ids.filter((id) => flags.pending.has(id))),
  });
  const publicForm = async () => {
    const loaded = await loadPublicForm(db, form.publicId);
    if (!loaded) throw new Error("The form did not load.");
    return loaded;
  };
  return { db, mock, services, seeded, run, field, form, limiter, flags, deps, publicForm };
}

async function submit(
  deps: SignupDeps,
  form: PublicForm,
  email: string,
  fields: Record<string, string[]> = {},
) {
  const checked = validateSubmission(form.defs, { email, fields });
  if (!checked.ok) throw new Error(checked.errors.map((error) => error.message).join(" "));
  return submitSignup(deps, form, {
    email: checked.email,
    values: checked.values,
    ipHash: "iphash-1",
    userAgent: "Mozilla/5.0 Test",
    origin: TEST_ORIGIN,
  });
}

/** The confirmation tokens in the emails that the mock received, oldest first. */
function tokensIn(mock: ProviderMock): string[] {
  // Each email has the link twice: in the HTML and in the text.
  return mock.calls.flatMap((call) => [
    ...new Set(
      [...call.body.matchAll(/\/f\/confirm\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1] ?? ""),
    ),
  ]);
}

async function signupCount(db: DbConnection, workspaceId: number, email: string) {
  const rows = await db.db
    .selectFrom("signups")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("email", "=", email)
    .execute();
  return rows.length;
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

describe("signup with double opt-in (F1)", () => {
  it("stores a pending signup, emails a link, and subscribes the contact with the form's consent basis on confirm", async () => {
    const { db, mock, seeded, field, form, deps, publicForm } = await setup();
    const loaded = await publicForm();
    const [design, , writing] = field.options;
    const outcome = await submit(deps(), loaded, " New.Reader@Example.org ", {
      [loaded.defs[0]?.key ?? ""]: [String(design?.id), String(writing?.id)],
    });
    expect(outcome).toEqual({ emailed: true, result: "sent" });
    expect(mock.delivered).toEqual(["new.reader@example.org"]);
    const sent = JSON.parse(mock.calls[0]?.body ?? "[]")[0];
    expect(sent.subject).toBe("Confirm your subscription to Course news");
    // System email: no List-Unsubscribe, and the From address is on the sending domain.
    expect(sent.from).toBe("Campaigns <noreply@mail.example.com>");
    expect(JSON.stringify(sent.headers ?? {})).not.toContain("List-Unsubscribe");
    const [token] = tokensIn(mock);
    if (!token) throw new Error("No confirmation link in the email.");

    // The stored token is a hash, never the token.
    const row = await db.db
      .selectFrom("signups")
      .selectAll()
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "new.reader@example.org")
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expires_at).toBe(T0 + SIGNUP_TOKEN_TTL_MS);
    expect(row.consent_version).toBe(1);

    // Pending: no contact and no membership yet.
    const before = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "new.reader@example.org")
      .executeTakeFirst();
    expect(before).toBeUndefined();

    // The GET of the link only reads the state. Nothing changes.
    expect((await signupOfToken(db, token, T0 + HOUR)).kind).toBe("ready");
    expect((await signupOfToken(db, token, T0 + HOUR)).kind).toBe("ready");

    const confirmed = await confirmSignup(db, token, T0 + HOUR);
    expect(confirmed.kind).toBe("confirmed");
    if (confirmed.kind !== "confirmed") return;
    const contact = await db.db
      .selectFrom("contacts")
      .selectAll()
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", confirmed.contactId)
      .executeTakeFirstOrThrow();
    expect(contact).toMatchObject({
      email: "new.reader@example.org",
      consent_basis: "explicit_opt_in",
      consent_source: "form",
      source: "form",
      unsubscribed_at: null,
    });
    expect(contact.email_hash).toBe(row.email_hash);
    const membership = await db.db
      .selectFrom("list_members")
      .selectAll()
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", confirmed.contactId)
      .execute();
    expect(membership).toMatchObject([
      { list_id: seeded.listId, status: "subscribed", status_source: "form" },
    ]);
    const events = await db.db
      .selectFrom("consent_events")
      .selectAll()
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", confirmed.contactId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      basis: "explicit_opt_in",
      source: "form",
      actor_type: "system",
      actor_id: `form:${form.id}`,
    });
    const evidence = await db.db
      .selectFrom("form_consents")
      .selectAll()
      .where("workspace_id", "=", seeded.workspaceId)
      .where("consent_event_id", "=", events[0]?.id ?? 0)
      .executeTakeFirstOrThrow();
    expect(evidence).toMatchObject({
      form_id: form.id,
      consent_version: 1,
      ip_hash: "iphash-1",
      user_agent: "Mozilla/5.0 Test",
    });
    const value = await db.db
      .selectFrom("contact_field_values")
      .select("value")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", confirmed.contactId)
      .where("field_id", "=", field.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(value.value ?? "[]")).toEqual(
      [design?.id, writing?.id].sort((a, b) => (a ?? 0) - (b ?? 0)),
    );

    // A second press shows the confirmed page and writes nothing more.
    const again = await confirmSignup(db, token, T0 + HOUR + 1000);
    expect(again).toMatchObject({ kind: "confirmed", already: true });
    expect((await signupOfToken(db, token, T0 + HOUR)).kind).toBe("confirmed");
  });

  it("keeps a pending signup out of the campaign estimate and the snapshot (AE2)", async () => {
    const { db, services, seeded, run, deps, publicForm } = await setup();
    await submit(deps(), await publicForm(), "pending.one@example.org");
    const campaignId = await createDraft(db, seeded);
    const campaign = await loadCampaign(db, seeded.workspaceId, campaignId);
    const estimate = await estimateAudience(
      db,
      seeded.workspaceId,
      campaignAudience(campaign),
      campaign.type,
    );
    expect(estimate.recipients).toBe(2);

    const prepared = await run<{ token: string }>(campaignsPrepare, {
      id: campaignId,
      mode: "send_now",
    });
    await run(campaignsConfirm, { id: campaignId, token: prepared.token }, T0 + 1000);
    const job = { workspaceId: seeded.workspaceId, campaignId, startedAt: T0 + 1000 };
    const begin = await beginSnapshot(db, job);
    if (begin.state === "stop") throw new Error(begin.reason);
    await snapshotPage(
      db,
      services.sendQueue,
      job,
      { afterId: 0, cut: begin.cut, batchSize: begin.batchSize },
      T0 + 2000,
    );
    const recipients = await db.db
      .selectFrom("campaign_recipients as r")
      .innerJoin("contacts as c", "c.id", "r.contact_id")
      .select("c.email")
      .where("r.workspace_id", "=", seeded.workspaceId)
      .where("r.campaign_id", "=", campaignId)
      .execute();
    expect(recipients.map((item) => item.email)).not.toContain("pending.one@example.org");
    expect(recipients).toHaveLength(2);
  });
});

describe("what gets no email", () => {
  it("sends nothing to a suppressed address and stores no signup", async () => {
    const { db, mock, services, seeded, deps, publicForm } = await setup();
    await db.db
      .insertInto("suppressions")
      .values({
        workspace_id: seeded.workspaceId,
        email_hash: await services.hashEmail("blocked@example.org"),
        reason: "complaint",
        source: "test",
        campaign_id: null,
      })
      .execute();
    const outcome = await submit(deps(), await publicForm(), "Blocked@example.org");
    expect(outcome).toEqual({ emailed: false, skip: "suppressed" });
    expect(mock.calls).toHaveLength(0);
    expect(await signupCount(db, seeded.workspaceId, "blocked@example.org")).toBe(0);
  });

  it("sends nothing to an address that is subscribed to every list of the form", async () => {
    const { mock, deps, publicForm } = await setup();
    // The seeded contacts are student1 and student2, subscribed to the list.
    const outcome = await submit(deps(), await publicForm(), "student1@example.org");
    expect(outcome).toEqual({ emailed: false, skip: "subscribed" });
    expect(mock.calls).toHaveLength(0);
  });

  it("sends nothing to a contact with an unsubscribe in the ledger (KTD1)", async () => {
    const { db, mock, seeded, flags, deps, publicForm } = await setup();
    const contact = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", seeded.workspaceId)
      .where("email", "=", "student2@example.org")
      .executeTakeFirstOrThrow();
    await db.db
      .updateTable("list_members")
      .set({ status: "unsubscribed" })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("contact_id", "=", contact.id)
      .execute();
    flags.unsubscribesPending = true;
    flags.pending.add(contact.id);
    const outcome = await submit(deps(), await publicForm(), "student2@example.org");
    expect(outcome).toEqual({ emailed: false, skip: "unsubscribe_pending" });
    expect(mock.calls).toHaveLength(0);
  });

  it("writes and sends nothing at the D1 platform limit", async () => {
    const { db, mock, seeded, flags, deps, publicForm } = await setup();
    flags.limited = true;
    const outcome = await submit(deps(), await publicForm(), "late@example.org");
    expect(outcome).toEqual({ emailed: false, skip: "platform_limit" });
    expect(mock.calls).toHaveLength(0);
    expect(await signupCount(db, seeded.workspaceId, "late@example.org")).toBe(0);
  });

  it("sends one email per address per hour, and the first link keeps working", async () => {
    const { db, mock, limiter, deps, publicForm } = await setup();
    const form = await publicForm();
    expect(await submit(deps(), form, "twice@example.org")).toMatchObject({ emailed: true });
    limiter.clock = T0 + 10 * 60 * 1000;
    expect(await submit(deps(), form, "twice@example.org")).toEqual({
      emailed: false,
      skip: "rate_limited",
    });
    expect(mock.calls).toHaveLength(1);
    const [token] = tokensIn(mock);
    expect((await signupOfToken(db, token ?? "", limiter.clock)).kind).toBe("ready");
    // After the hour, a new submission sends a new link and replaces the old one.
    limiter.clock = T0 + HOUR + 1;
    expect(await submit(deps(), form, "twice@example.org")).toMatchObject({ emailed: true });
    const [old, fresh] = tokensIn(mock);
    expect((await signupOfToken(db, old ?? "", limiter.clock)).kind).toBe("invalid");
    expect((await signupOfToken(db, fresh ?? "", limiter.clock)).kind).toBe("ready");
  });
});

describe("expired links and resends (KTD7)", () => {
  it("shows an expired link, sends a new link that replaces it, and stops after 3 resends", async () => {
    const { db, mock, limiter, deps, publicForm } = await setup();
    await submit(deps(), await publicForm(), "slow@example.org");
    const [first] = tokensIn(mock);
    if (!first) throw new Error("No link.");
    const late = T0 + SIGNUP_TOKEN_TTL_MS + 1;
    expect((await signupOfToken(db, first, late)).kind).toBe("expired");
    expect(await confirmSignup(db, first, late)).toEqual({ kind: "expired" });

    let token = first;
    for (let round = 1; round <= 3; round++) {
      limiter.clock = late + round * 2 * HOUR;
      const outcome = await resendSignup(deps(), token, TEST_ORIGIN);
      expect(outcome).toEqual({ kind: "done", emailed: true, result: "sent" });
      const next = tokensIn(mock).at(-1) ?? "";
      expect(next).not.toBe(token);
      expect((await signupOfToken(db, token, limiter.clock)).kind).toBe("invalid");
      expect((await signupOfToken(db, next, limiter.clock)).kind).toBe("ready");
      token = next;
    }
    // Let the last link expire too: no fourth resend.
    limiter.clock = late + 10 * HOUR + SIGNUP_TOKEN_TTL_MS;
    expect(await resendSignup(deps(), token, TEST_ORIGIN)).toEqual({ kind: "exhausted" });
    expect(tokensIn(mock)).toHaveLength(4);

    // The last link still confirms while it is valid.
    const confirmed = await confirmSignup(db, token, late + 7 * HOUR);
    expect(confirmed.kind).toBe("confirmed");
  });

  it("a resend within the hour of the first email sends nothing", async () => {
    const { mock, limiter, deps, publicForm } = await setup();
    await submit(deps(), await publicForm(), "eager@example.org");
    const [token] = tokensIn(mock);
    limiter.clock = T0 + 5 * 60 * 1000;
    expect(await resendSignup(deps(), token ?? "", TEST_ORIGIN)).toEqual({
      kind: "done",
      emailed: false,
      skip: "rate_limited",
    });
    expect(mock.calls).toHaveLength(1);
  });
});

describe("form values", () => {
  it("refuses a forged option id and a bad email, and ignores fields that the form does not show", async () => {
    const { field, publicForm } = await setup();
    const form = await publicForm();
    const key = form.defs[0]?.key ?? "";
    const forged = validateSubmission(form.defs, {
      email: "not-an-address",
      fields: { [key]: ["999999"], other_field: ["x"] },
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.errors.map((error) => error.target)).toEqual(["email", `field-${key}`]);
    const label = validateSubmission(form.defs, {
      email: "a@example.org",
      fields: { [key]: ["Design"] },
    });
    expect(label.ok).toBe(false);
    const good = validateSubmission(form.defs, {
      email: "a@example.org",
      fields: { [key]: [String(field.options[1]?.id)], other_field: ["x"] },
    });
    expect(good).toEqual({
      ok: true,
      email: "a@example.org",
      values: { [key]: [field.options[1]?.id] },
    });
  });

  it("refuses a submission without an answer to a required field", async () => {
    const { run, form, field, publicForm } = await setup();
    const updated = await run<Form>(formsUpdate, {
      ...form,
      requiredFieldIds: [field.id],
    });
    expect(updated.requiredFieldIds).toEqual([field.id]);
    const loaded = await publicForm();
    expect(loaded.page.fields[0]?.required).toBe(true);
    const key = loaded.defs[0]?.key ?? "";
    const missing = validateSubmission(
      loaded.defs,
      { email: "a@example.org", fields: {} },
      loaded.required,
    );
    expect(missing).toEqual({
      ok: false,
      errors: [{ target: `field-${key}`, message: "Select an option for Interests." }],
    });
    const answered = validateSubmission(
      loaded.defs,
      { email: "a@example.org", fields: { [key]: [String(field.options[0]?.id)] } },
      loaded.required,
    );
    expect(answered.ok).toBe(true);
    // A required field must be a field of the form.
    await expect(
      run(formsUpdate, { ...form, fieldIds: [], requiredFieldIds: [field.id] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("form settings", () => {
  it("accepts bare https origins and refuses wildcards, paths, CR and LF, and plain http", () => {
    expect(normalizeEmbedOrigin("https://WWW.Example.com/")).toBe("https://www.example.com");
    expect(normalizeEmbedOrigin("https://example.com:8443")).toBe("https://example.com:8443");
    expect(normalizeEmbedOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    for (const bad of [
      "https://*.example.com",
      "*",
      "https://example.com/blog",
      "https://example.com/?a=1",
      "https://example.com\r\nX-Evil: 1",
      "https://example.com\nhttps://evil.test",
      "https://example.com https://evil.test",
      "https://example.com;script-src *",
      "http://example.com",
      "https://user:pw@example.com",
      "'self'",
      "javascript:alert(1)",
    ]) {
      expect(() => normalizeEmbedOrigin(bad), bad).toThrow();
    }
  });

  it("rejects a bad origin on save and raises the consent version when the text changes", async () => {
    const { run, form } = await setup();
    const base = {
      id: form.id,
      name: "Course news",
      listIds: form.listIds,
      fieldIds: [],
      consentText: "I agree to get the course news.",
      successMessage: "Welcome.",
      allowedOrigins: ["https://www.example.com"],
      fromName: null,
      fromEmail: null,
      enabled: true,
    };
    expect(
      await failure(run(formsUpdate, { ...base, allowedOrigins: ["https://*.example.com"] })),
    ).toBe("invalid_input");
    expect(
      await failure(run(formsUpdate, { ...base, allowedOrigins: ["https://example.com/page"] })),
    ).toBe("invalid_input");
    expect(await failure(run(formsUpdate, { ...base, listIds: [], enabled: true }))).toBe(
      "invalid_input",
    );
    expect(await failure(run(formsUpdate, { ...base, fromEmail: "me@other.test" }))).toBe(
      "invalid_input",
    );
    const same = await run<Form>(formsUpdate, base);
    expect(same.consentVersion).toBe(1);
    const changed = await run<Form>(formsUpdate, { ...base, consentText: "New consent text." });
    expect(changed.consentVersion).toBe(2);
    const read = await run<Form & { hostedUrl: string; embedSnippet: string }>(formsGet, {
      id: form.id,
    });
    expect(read.hostedUrl).toBe(`${TEST_ORIGIN}/f/${form.publicId}`);
    expect(read.embedSnippet).toContain(`src="${TEST_ORIGIN}/f/${form.publicId}?embed=1"`);
    const list = await run<{ turnstileConfigured: boolean; items: Form[] }>(formsList, {});
    expect(list.turnstileConfigured).toBe(true);
    expect(list.items.map((item) => item.id)).toContain(form.id);
  });

  it("keeps form changes away from API keys", async () => {
    const { db, services, seeded } = await setup();
    const key = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["contacts:read", "contacts:write", "lists:write"],
      surface: "rest",
    });
    const code = await failure(
      runOperation(key, formsCreate, { name: "Agent form" }, { db, services, now: () => T0 }),
    );
    expect(code).toBe("forbidden");
    const read = await runOperation(key, formsList, {}, { db, services, now: () => T0 });
    expect(read).toHaveProperty("items");
  });
});

describe("cleanup", () => {
  it("deletes signups 7 days after they were created, once the link has expired", async () => {
    const { db, seeded, deps, publicForm } = await setup();
    await submit(deps(), await publicForm(), "old@example.org");
    expect(await purgeExpiredSignups(db, T0 + 6 * 24 * HOUR)).toBe(0);
    expect(await signupCount(db, seeded.workspaceId, "old@example.org")).toBe(1);
    await purgeExpiredSignups(db, T0 + 7 * 24 * HOUR + 1);
    expect(await signupCount(db, seeded.workspaceId, "old@example.org")).toBe(0);
  });
});

describe("confirmation emails at the daily cap (U19)", () => {
  it("waits in the outbox while the cap has no room, then goes out with a working link", async () => {
    const { db, mock, services, seeded, run, deps, publicForm } = await setup();
    await db.db
      .updateTable("provider_connections")
      .set({ daily_cap: 3 })
      .where("workspace_id", "=", seeded.workspaceId)
      .where("id", "=", seeded.connectionId)
      .execute();
    services.dailyClock.now = T0;
    await services.dailyCounter.reserve(seeded.connectionId, 3, 3);

    const outcome = await submit(deps(), await publicForm(), "reader@example.org");
    expect(outcome).toEqual({ emailed: true, result: "deferred" });
    expect(mock.calls).toHaveLength(0);
    const usage = await run<{ waitingConfirmations: number; usedLast24h: number }>(
      connectionsDailyUsage,
      { id: seeded.connectionId },
    );
    expect(usage).toMatchObject({ waitingConfirmations: 1, usedLast24h: 3 });

    // The cron finds no room yet, and keeps the email.
    expect(await sendDeferredConfirmations({ db, services, now: T0 + HOUR })).toBe(0);
    expect(mock.calls).toHaveLength(0);

    // After 24 hours the counter has room: the email goes out with a new token.
    const later = T0 + 25 * HOUR;
    services.dailyClock.now = later;
    expect(await sendDeferredConfirmations({ db, services, now: later })).toBe(1);
    const tokens = tokensIn(mock);
    expect(tokens).toHaveLength(1);
    const state = await signupOfToken(db, tokens[0] as string, later + HOUR);
    expect(state.kind).toBe("ready");
    expect(await services.dailyCounter.used(seeded.connectionId)).toBe(1);
    expect(
      await run<{ waitingConfirmations: number }>(connectionsDailyUsage, {
        id: seeded.connectionId,
      }),
    ).toMatchObject({ waitingConfirmations: 0 });
    // A second run sends nothing again.
    expect(await sendDeferredConfirmations({ db, services, now: later })).toBe(0);
  });
});
