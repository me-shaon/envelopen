import { env } from "cloudflare:workers";
import {
  DEFAULT_SOURCE_URL,
  type Operation,
  registry,
  runOperation,
  SOURCE_URL_SETTING,
  settingsUpdate,
} from "@envelopen/core";
import { afterEach, describe, expect, it } from "vitest";
import { dbOver, limitedD1, SIGNING_KEY } from "../../test/campaign-helpers";
import { call, mount, recordingDeps, sentCampaign } from "../../test/tracking-helpers";
import { settingsCache } from "../services";
import { ENVELOPEN_VERSION } from "../version";
import { formToken } from "./csrf";
import { createTrackingRoutes, createUnsubscribeRoutes } from "./index";
import { renderPage } from "./preferences";

// The source link in the footer of every public page (KTD16, R6, AGPL section 13).

async function setup() {
  const sent = await sentCampaign();
  const deps = await recordingDeps(sent.db);
  return {
    sent,
    u: mount("/u", createUnsubscribeRoutes({ deps: () => deps })),
    t: mount("/t", createTrackingRoutes({ deps: () => deps })),
  };
}

/** The href of the "Source code" link in the footer. */
function sourceLink(html: string): string | undefined {
  const footer = html.slice(html.indexOf("<footer>"));
  return /<a href="([^"]*)"[^>]*>\s*Source code\s*<\/a>/.exec(footer)?.[1];
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM system_settings WHERE key = ?").bind(SOURCE_URL_SETTING).run();
  await env.KV.delete(`settings:${SOURCE_URL_SETTING}`);
});

describe("the source link on public pages", () => {
  it("shows the default link and the version on the preference page", async () => {
    const { sent, u } = await setup();
    const html = await (await call(u, `/u/${sent.tokens[0]}`)).text();
    expect(sourceLink(html)).toBe(DEFAULT_SOURCE_URL);
    expect(html).toContain(`Sent with Envelopen ${ENVELOPEN_VERSION}`);
    expect(ENVELOPEN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows the owner's custom link on every public page after a change", async () => {
    const { sent, u, t } = await setup();
    const token = sent.tokens[0] as string;
    // Warm the cache with the default first, so the change must write through.
    expect(sourceLink(await (await call(u, `/u/${token}`)).text())).toBe(DEFAULT_SOURCE_URL);

    const custom = "https://git.example.com/acme/envelopen";
    await runOperation(
      sent.seeded.principal,
      settingsUpdate,
      { sourceUrl: custom },
      { db: sent.db, services: { settingsCache: settingsCache(env) } },
    );

    const pages: [ReturnType<typeof mount>, string, RequestInit?][] = [
      [u, `/u/${token}`],
      [u, `/u/${token}/preferences?step=confirm-all`],
      [u, "/u/test"],
      [u, "/u/x/y/z"],
      [t, "/t/invalid"],
      [t, "/t/nothing-here"],
      [
        u,
        `/u/${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ],
      // The contact is unsubscribed now: the "already unsubscribed" page.
      [u, `/u/${token}`],
    ];
    for (const [app, path, init] of pages) {
      const html = await (await call(app, path, init)).text();
      expect(sourceLink(html), path).toBe(custom);
      expect(html, path).toContain(ENVELOPEN_VERSION);
    }
  });

  it("escapes the link in the HTML", async () => {
    const { html } = await renderPage(
      { kind: "invalid" },
      'https://example.com/"><script>alert(1)</script>',
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

// Custom fields on the preference page (U9, R14).

describe("custom fields on the preference page", () => {
  async function fieldSetup() {
    const sent = await sentCampaign();
    const principal = sent.seeded.principal;
    const run = (op: string, input: Record<string, unknown>) =>
      runOperation(principal, registry.get(op) as Operation, input, { db: sent.db }) as Promise<{
        id: number;
        options: { id: number; label: string }[];
      }>;
    const frequency = await run("fields.create", {
      key: "frequency",
      label: "Frequency",
      type: "choice",
      options: ["Weekly", "Monthly"],
      preference: "editable",
    });
    const weekly = frequency.options[0]?.id as number;
    const monthly = frequency.options[1]?.id as number;
    // The same field is asked on a signup form.
    const form = (await run("forms.create", {
      name: "Newsletter",
      listIds: [sent.seeded.listId],
      fieldIds: [frequency.id],
      requiredFieldIds: [frequency.id],
    })) as unknown as { fieldIds: number[]; requiredFieldIds: number[] };
    expect(form.requiredFieldIds).toEqual([frequency.id]);
    const course = await run("fields.create", {
      key: "course",
      label: "Course <b>name</b>",
      type: "text",
      preference: "read_only",
    });
    const secret = await run("fields.create", { key: "secret", label: "Secret", type: "text" });
    const contactId = sent.recipients[0]?.contact_id as number;
    await run("contacts.update", {
      id: contactId,
      fields: { frequency: weekly, course: "Design 101", secret: "s3" },
    });
    const deps = await recordingDeps(sent.db);
    const app = mount("/u", createUnsubscribeRoutes({ deps: () => deps }));
    const storedValue = async (fieldId: number) =>
      (
        await env.DB.prepare(
          "SELECT value FROM contact_field_values WHERE contact_id = ? AND field_id = ?",
        )
          .bind(contactId, fieldId)
          .first<{ value: string | null }>()
      )?.value ?? null;
    return {
      sent,
      app,
      deps,
      token: sent.tokens[0] as string,
      ids: { frequency: frequency.id, course: course.id, secret: secret.id, weekly, monthly },
      storedValue,
    };
  }

  async function formPost(token: string, fields: Record<string, string | string[]>) {
    const body = new URLSearchParams();
    body.set("csrf", await formToken(SIGNING_KEY, token));
    for (const [key, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
    }
    return {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://envelopen.test",
        "sec-fetch-site": "same-origin",
      },
      body: body.toString(),
    } satisfies RequestInit;
  }

  it("shows a radio field of a form on the page, and a change saves", async () => {
    const { sent, app, token, ids, storedValue } = await fieldSetup();
    const html = await (await call(app, `/u/${token}`)).text();
    expect(html).toContain("<legend>Frequency</legend>");
    expect(html).toMatch(
      new RegExp(
        `type="radio" id="field-frequency" name="f_frequency" value="${ids.weekly}" checked`,
      ),
    );
    expect(html).toContain(`name="f_frequency" value="${ids.monthly}"`);
    const listId = String(sent.seeded.listId);
    const saved = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, {
        action: "save",
        shown: listId,
        list: listId,
        field_shown: "frequency",
        f_frequency: String(ids.monthly),
      }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/u/${token}/preferences?state=saved`);
    expect(await storedValue(ids.frequency)).toBe(String(ids.monthly));
    const after = await (await call(app, `/u/${token}/preferences?state=saved`)).text();
    expect(after).toContain("Your choices are saved.");
    expect(after).toMatch(new RegExp(`value="${ids.monthly}" checked`));
  });

  it("shows a read-only field as text, hides a hidden field, and ignores posts to both", async () => {
    const { app, token, ids, storedValue } = await fieldSetup();
    const html = await (await call(app, `/u/${token}`)).text();
    expect(html).toContain("Design 101");
    expect(html).not.toContain('name="f_course"');
    expect(html).not.toContain("Secret");
    expect(html).not.toContain("s3");
    // The label of the owner is escaped text.
    expect(html).toContain("Course &lt;b&gt;name&lt;/b&gt;");
    expect(html).not.toContain("<b>name</b>");
    const saved = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, {
        action: "save",
        field_shown: ["course", "secret", "frequency"],
        f_course: "Forged",
        f_secret: "Forged",
        f_frequency: String(ids.weekly),
      }),
    );
    expect(saved.status).toBe(303);
    expect(await storedValue(ids.course)).toBe("Design 101");
    expect(await storedValue(ids.secret)).toBe("s3");
  });

  it("refuses a forged option id and changes nothing", async () => {
    const { sent, app, token, ids, storedValue } = await fieldSetup();
    for (const forged of ["999999", "Monthly", String(ids.course)]) {
      const response = await call(
        app,
        `/u/${token}/preferences`,
        await formPost(token, {
          action: "save",
          field_shown: "frequency",
          f_frequency: forged,
        }),
      );
      expect(response.status, forged).toBe(400);
      const html = await response.text();
      expect(html).toContain("Correct the problems below");
      expect(html).toContain("Select an option from the list for Frequency.");
      expect(html).toContain('aria-invalid="true"');
    }
    expect(await storedValue(ids.frequency)).toBe(String(ids.weekly));
    // The list choice of the refused save is not applied either.
    const members = await env.DB.prepare(
      "SELECT status FROM list_members WHERE contact_id = ? AND list_id = ?",
    )
      .bind(sent.recipients[0]?.contact_id, sent.seeded.listId)
      .first<{ status: string }>();
    expect(members?.status).toBe("subscribed");
  });

  it("at the D1 limit, keeps the list choice in the ledger and asks to try the field change later", async () => {
    const { sent, token, ids, storedValue } = await fieldSetup();
    const deps = await recordingDeps(dbOver(limitedD1(env.DB)), Date.now() + 60_000);
    const app = mount("/u", createUnsubscribeRoutes({ deps: () => deps }));
    const listId = String(sent.seeded.listId);
    // A save at the limit that changes no field shows the usual notice.
    const same = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, {
        action: "save",
        shown: listId,
        list: listId,
        field_shown: "frequency",
        f_frequency: String(ids.weekly),
      }),
    );
    expect(same.headers.get("location")).toBe(`/u/${token}/preferences?state=saved`);
    expect(await deps.ledger.list()).toEqual([]);

    const saved = await call(
      app,
      `/u/${token}/preferences`,
      await formPost(token, {
        action: "save",
        shown: listId,
        field_shown: "frequency",
        f_frequency: String(ids.monthly),
      }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/u/${token}/preferences?state=retry`);
    expect((await deps.ledger.list()).map((item) => item.listId)).toEqual([sent.seeded.listId]);
    expect(await storedValue(ids.frequency)).toBe(String(ids.weekly));
    const page = await (await call(app, `/u/${token}/preferences?state=retry`)).text();
    expect(page).toContain("Your answers were not saved. Try again later.");
  });
});
