import { formsCreate, formsUpdate, readSourceUrl, runOperation } from "@envelopen/core";
import { seedCampaignWorkspace } from "@envelopen/core/testing/campaign-fixtures";
import { createProviderMock } from "@envelopen/core/testing/provider-mock";
import { FORM_COPY } from "@envelopen/email-render/form-page";
import { describe, expect, it } from "vitest";
import { campaignDb, T0, testKeys } from "../../test/campaign-helpers";
import { call, mount, ORIGIN } from "../../test/tracking-helpers";
import type { FormDeps } from "./deps";
import { createFormRoutes } from "./routes";
import { SITEVERIFY_URL, verifyTurnstile } from "./turnstile";

// The public form routes (U8, F1, KTD6, KTD7): the hosted page and its CSP, the uniform
// "check your inbox" page, Turnstile, and the confirmation that only a POST does.

const HOUR = 60 * 60 * 1000;
const SITE_KEY = "0x4AAAAAAAtestsitekey";
const SECRET = "0x4AAAAAAAtestsecret";

interface Setup {
  f: ReturnType<typeof mount>;
  emails: { to: string | string[]; html: string; text?: string; subject: string }[];
  siteverify: { body: URLSearchParams }[];
  clock: { now: number };
  db: ReturnType<typeof campaignDb>;
  workspaceId: number;
  listId: number;
  publicId: string;
  formId: number;
  hashEmail: (email: string) => Promise<string>;
  disable(): Promise<unknown>;
}

async function setup(
  options: { name?: string; consent?: string; success?: string; turnstile?: boolean } = {},
): Promise<Setup> {
  const db = campaignDb();
  const { credentials, hashEmail } = await testKeys();
  const seeded = await seedCampaignWorkspace(db, { credentials, hashEmail }, { contacts: 1 });
  const mock = createProviderMock();
  const siteverify: Setup["siteverify"] = [];
  // Siteverify: a token `pass-<action>` passes for that action on the test origin.
  const outbound: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === SITEVERIFY_URL) {
      const body = new URLSearchParams(await request.text());
      siteverify.push({ body });
      const token = body.get("response") ?? "";
      const action = token.startsWith("pass-") ? token.slice(5) : null;
      return Response.json(
        action
          ? { success: true, hostname: new URL(ORIGIN).hostname, action, "error-codes": [] }
          : { success: false, "error-codes": ["invalid-input-response"] },
      );
    }
    return mock.fetch(request);
  };
  const services = { hashEmail, credentials, outboundFetch: outbound, appOrigin: ORIGIN };
  const form = await runOperation(
    seeded.principal,
    formsCreate,
    {
      name: options.name ?? "Course news",
      listIds: [seeded.listId],
      consentText: options.consent ?? "I agree to get the course news.",
      successMessage: options.success ?? "Welcome to the course news.",
      allowedOrigins: ["https://www.example.com"],
      enabled: true,
    },
    { db, services, now: () => T0 },
  );
  const clock = { now: T0 };
  const windows = new Map<string, { start: number; count: number }>();
  const deps = (): FormDeps => ({
    db,
    services,
    now: () => clock.now,
    sourceUrl: () => readSourceUrl(db),
    turnstile: options.turnstile === false ? null : { siteKey: SITE_KEY, secret: SECRET },
    verifyTurnstile: (request) => verifyTurnstile(outbound, SECRET, request),
    limiter: {
      async record(key, rule) {
        const window = windows.get(key);
        if (!window || clock.now - window.start >= rule.windowMs) {
          windows.set(key, { start: clock.now, count: 1 });
          return { count: 1 };
        }
        window.count++;
        return { count: window.count };
      },
    },
    usage: async () => ({ limited: false, unsubscribesPending: false }),
    pendingUnsubscribes: async () => new Set(),
    ipHash: async (ip) => `hash-of-${ip}`,
  });
  const emails = new Proxy([] as Setup["emails"], {
    get(target, prop, receiver) {
      target.length = 0;
      for (const sent of mock.calls) {
        target.push(...(JSON.parse(sent.body || "[]") as Setup["emails"]));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    f: mount("/f", createFormRoutes({ deps: () => deps() })),
    emails,
    siteverify,
    clock,
    db,
    workspaceId: seeded.workspaceId,
    listId: seeded.listId,
    publicId: form.publicId,
    formId: form.id,
    hashEmail,
    disable: () =>
      runOperation(
        seeded.principal,
        formsUpdate,
        {
          id: form.id,
          name: "Off",
          listIds: [seeded.listId],
          fieldIds: [],
          consentText: "x",
          successMessage: "y",
          allowedOrigins: [],
          fromName: null,
          fromEmail: null,
          enabled: false,
        },
        { db, services, now: () => T0 },
      ),
  };
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return [
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "198.51.100.7",
        ...SAME_ORIGIN,
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    },
  ] as const;
}

function tokenOf(html: string): string {
  const token = /\/f\/confirm\/([A-Za-z0-9_-]{43})/.exec(html)?.[1];
  if (!token) throw new Error("No confirmation link.");
  return token;
}

/** The page without its nonce, so two responses can be compared. */
function stable(html: string): string {
  return html.replaceAll(/nonce="[^"]*"/g, 'nonce=""');
}

describe("the hosted form page", () => {
  it("loads Turnstile under a strict CSP and allows only its checked embed origins", async () => {
    const { f, publicId } = await setup();
    const response = await call(f, `/f/${publicId}?embed=1`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toMatch(/style-src 'nonce-[0-9a-f]{32}'/);
    expect(csp).toContain("frame-ancestors 'self' https://www.example.com");
    expect(csp).toContain("form-action 'self'");
    expect(response.headers.get("x-frame-options")).toBeNull();
    const html = await response.text();
    expect(html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    expect(html).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(html).toContain('data-action="signup"');
    expect(html).toContain(`action="/f/${publicId}?embed=1"`);
    expect(html).toContain('<label for="email">Email address</label>');
    expect(html).toContain("I agree to get the course news.");
    expect(html).toContain('<body class="embed">');
    // Only the Turnstile script: no inline script.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("escapes the owner's texts", async () => {
    const attack = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const { f, publicId } = await setup({ name: attack, consent: attack, success: attack });
    const html = await (await call(f, `/f/${publicId}`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("shows a setup notice and refuses submissions without Turnstile keys", async () => {
    const { f, publicId, emails } = await setup({ turnstile: false });
    const page = await call(f, `/f/${publicId}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("This form is not set up yet.");
    const submitted = await call(f, ...post(`/f/${publicId}`, { email: "a@example.org" }));
    expect(submitted.status).toBe(503);
    expect(emails).toHaveLength(0);
  });

  it("shows nothing for an unknown or disabled form", async () => {
    const { f, publicId, disable } = await setup();
    expect((await call(f, "/f/0123456789abcdef0123")).status).toBe(404);
    await disable();
    const off = await call(f, `/f/${publicId}`);
    expect(off.status).toBe(404);
    expect(await off.text()).toContain(FORM_COPY.unavailableTitle);
  });
});

describe("a submission (F1)", () => {
  it("emails a link, the GET of the link confirms nothing, and the Confirm button subscribes", async () => {
    const { f, publicId, emails, db, workspaceId, listId, siteverify } = await setup();
    const response = await call(
      f,
      ...post(`/f/${publicId}`, {
        email: "Reader@Example.org",
        "cf-turnstile-response": "pass-signup",
      }),
    );
    expect(response.status).toBe(200);
    const inbox = await response.text();
    expect(inbox).toContain(FORM_COPY.inboxTitle);
    expect(siteverify[0]?.body.get("secret")).toBe(SECRET);
    expect(siteverify[0]?.body.get("remoteip")).toBe("198.51.100.7");
    expect(emails.flatMap((email) => email.to)).toEqual(["reader@example.org"]);
    const token = tokenOf(emails[0]?.html ?? "");
    expect(emails[0]?.html).toContain(`${ORIGIN}/f/confirm/${token}`);

    // A mail scanner opens the link twice. Nothing changes.
    for (let i = 0; i < 2; i++) {
      const page = await call(f, `/f/confirm/${token}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
      const html = await page.text();
      expect(html).toContain(FORM_COPY.confirmTitle);
      expect(html).toContain(`<form method="post" action="/f/confirm/${token}">`);
    }
    const none = await db.db
      .selectFrom("contacts")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", "reader@example.org")
      .executeTakeFirst();
    expect(none).toBeUndefined();

    // A POST from another site is refused.
    const forged = await call(
      f,
      ...post(`/f/confirm/${token}`, {}, { "sec-fetch-site": "cross-site" }),
    );
    expect(forged.status).toBe(403);

    const confirmed = await call(f, ...post(`/f/confirm/${token}`, {}));
    expect(confirmed.status).toBe(200);
    const done = await confirmed.text();
    expect(done).toContain(FORM_COPY.confirmedTitle);
    expect(done).toContain("Welcome to the course news.");
    const contact = await db.db
      .selectFrom("contacts")
      .select(["id", "consent_basis"])
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", "reader@example.org")
      .executeTakeFirstOrThrow();
    expect(contact.consent_basis).toBe("explicit_opt_in");
    const member = await db.db
      .selectFrom("list_members")
      .select("status")
      .where("workspace_id", "=", workspaceId)
      .where("list_id", "=", listId)
      .where("contact_id", "=", contact.id)
      .executeTakeFirstOrThrow();
    expect(member.status).toBe("subscribed");
    const evidence = await db.db
      .selectFrom("form_consents")
      .select(["ip_hash", "consent_version"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(evidence).toEqual({ ip_hash: "hash-of-198.51.100.7", consent_version: 1 });
  });

  it("gives a suppressed address the same page and no email", async () => {
    const { f, publicId, emails, db, workspaceId, hashEmail } = await setup();
    await db.db
      .insertInto("suppressions")
      .values({
        workspace_id: workspaceId,
        email_hash: await hashEmail("gone@example.org"),
        reason: "erased",
        source: "test",
        campaign_id: null,
      })
      .execute();
    const fresh = await call(
      f,
      ...post(`/f/${publicId}`, {
        email: "new@example.org",
        "cf-turnstile-response": "pass-signup",
      }),
    );
    const blocked = await call(
      f,
      ...post(`/f/${publicId}`, {
        email: "gone@example.org",
        "cf-turnstile-response": "pass-signup",
      }),
    );
    expect(blocked.status).toBe(fresh.status);
    expect(stable(await blocked.text())).toBe(stable(await fresh.text()));
    expect(emails.flatMap((email) => email.to)).toEqual(["new@example.org"]);
  });

  it("sends no second email for the same address within the hour", async () => {
    const { f, publicId, emails, clock } = await setup();
    const fields = { email: "twice@example.org", "cf-turnstile-response": "pass-signup" };
    await call(f, ...post(`/f/${publicId}`, fields));
    clock.now += 20 * 60 * 1000;
    const second = await call(f, ...post(`/f/${publicId}`, fields));
    expect(await second.text()).toContain(FORM_COPY.inboxTitle);
    expect(emails).toHaveLength(1);
  });

  it("returns the form with an error and sends nothing when Turnstile fails", async () => {
    const { f, publicId, emails, siteverify } = await setup();
    for (const token of ["", "bad-token", "pass-resend"]) {
      const response = await call(
        f,
        ...post(`/f/${publicId}`, { email: "bot@example.org", "cf-turnstile-response": token }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(FORM_COPY.turnstileFailed);
      expect(html).toContain('role="alert"');
      expect(html).toContain("autofocus");
      expect(html).toContain('value="bot@example.org"');
    }
    // An empty token never reaches siteverify. The wrong action fails the action check.
    expect(siteverify).toHaveLength(2);
    expect(emails).toHaveLength(0);
  });

  it("shows field errors with an error summary and keeps the values", async () => {
    const { f, publicId, emails } = await setup();
    const response = await call(
      f,
      ...post(`/f/${publicId}`, { email: "not an email", "cf-turnstile-response": "pass-signup" }),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(FORM_COPY.errorTitle);
    expect(html).toContain(`<a href="#email">${FORM_COPY.emailInvalid}</a>`);
    expect(html).toContain('aria-invalid="true" aria-describedby="email-error"');
    expect(emails).toHaveLength(0);
  });

  it("refuses a submission from another site", async () => {
    const { f, publicId, emails } = await setup();
    const response = await call(
      f,
      ...post(
        `/f/${publicId}`,
        { email: "a@example.org", "cf-turnstile-response": "pass-signup" },
        { "sec-fetch-site": "cross-site" },
      ),
    );
    expect(response.status).toBe(403);
    expect(emails).toHaveLength(0);
  });
});

describe("expired links", () => {
  it("offers a resend that needs Turnstile and replaces the old link", async () => {
    const { f, publicId, emails, clock } = await setup();
    await call(
      f,
      ...post(`/f/${publicId}`, {
        email: "late@example.org",
        "cf-turnstile-response": "pass-signup",
      }),
    );
    const old = tokenOf(emails[0]?.html ?? "");
    clock.now = T0 + 73 * HOUR;
    const expired = await (await call(f, `/f/confirm/${old}`)).text();
    expect(expired).toContain(FORM_COPY.expiredTitle);
    expect(expired).toContain(`action="/f/confirm/${old}/resend"`);
    expect(expired).toContain('data-action="resend"');
    // The Confirm button of an old page does not confirm an expired link.
    const pressed = await call(f, ...post(`/f/confirm/${old}`, {}));
    expect(pressed.status).toBe(303);

    const refused = await call(f, ...post(`/f/confirm/${old}/resend`, {}));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(FORM_COPY.turnstileFailed);
    expect(emails).toHaveLength(1);

    const resent = await call(
      f,
      ...post(`/f/confirm/${old}/resend`, { "cf-turnstile-response": "pass-resend" }),
    );
    expect(await resent.text()).toContain(FORM_COPY.inboxTitle);
    expect(emails).toHaveLength(2);
    const fresh = tokenOf(emails[1]?.html ?? "");
    expect(fresh).not.toBe(old);
    expect((await call(f, `/f/confirm/${old}`)).status).toBe(404);
    expect(await (await call(f, `/f/confirm/${fresh}`)).text()).toContain(FORM_COPY.confirmTitle);
  });

  it("shows one generic page for a link that is not valid", async () => {
    const { f } = await setup();
    for (const path of ["/f/confirm/short", `/f/confirm/${"A".repeat(43)}`, "/f/unknown/path"]) {
      const response = await call(f, path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toContain(FORM_COPY.invalidTitle);
    }
  });
});

describe("Turnstile siteverify", () => {
  const reply =
    (body: unknown): typeof fetch =>
    async () =>
      Response.json(body);
  const request = { token: "t", ip: "1.2.3.4", hostname: "mail.example.com", action: "signup" };

  it("checks success, the hostname, and the action", async () => {
    const good = { success: true, hostname: "mail.example.com", action: "signup" };
    expect(await verifyTurnstile(reply(good), SECRET, request)).toEqual({ ok: true });
    expect(
      await verifyTurnstile(reply({ ...good, hostname: "evil.test" }), SECRET, request),
    ).toEqual({ ok: false, reason: "hostname-mismatch" });
    expect(await verifyTurnstile(reply({ ...good, action: "resend" }), SECRET, request)).toEqual({
      ok: false,
      reason: "action-mismatch",
    });
    expect(
      await verifyTurnstile(
        reply({ success: false, "error-codes": ["timeout-or-duplicate"] }),
        SECRET,
        request,
      ),
    ).toEqual({ ok: false, reason: "timeout-or-duplicate" });
    const down: typeof fetch = async () => {
      throw new Error("offline");
    };
    expect(await verifyTurnstile(down, SECRET, request)).toEqual({
      ok: false,
      reason: "siteverify-unreachable",
    });
  });

  it("accepts the documented test secrets without the hostname and action checks", async () => {
    // Cloudflare's test secret answers with hostname example.com and no action.
    const testReply = reply({ success: true, hostname: "example.com" });
    expect(
      await verifyTurnstile(testReply, "1x0000000000000000000000000000000AA", request),
    ).toEqual({ ok: true });
    expect(await verifyTurnstile(testReply, SECRET, request)).toEqual({
      ok: false,
      reason: "hostname-mismatch",
    });
  });
});
