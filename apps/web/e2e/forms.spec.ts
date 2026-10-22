import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CAMPAIGNS_MOCK_PORT, FORMS_MOCK_PORT, FORMS_PORT } from "../playwright.config";
import { watchCsp } from "./csp";

// Signup forms with double opt-in (plan U8, F1), against a fresh Worker that has
// Cloudflare's Turnstile test keys. Siteverify and the confirmation email go to the local
// provider mock (OUTBOUND_MOCK_ORIGIN), so nothing leaves the machine.
//
// The browser gets a stand-in for the Turnstile script at its real URL, so the page CSP
// applies as in production and the test needs no network. The stand-in does what the
// always-passing test widget does: it puts the test token in the form. A spike with the
// real widget showed the same result under this CSP, in the page and in an iframe.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${FORMS_PORT}`;
const MOCK = `http://127.0.0.1:${FORMS_MOCK_PORT}`;
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
// Two websites with the embed: the forms mock and the campaigns mock serve the page
// (GET /embed). The form allows the first one only. A real local server is needed:
// Chrome blocks a page that the test fulfills itself from loading a localhost frame.
const ALLOWED_SITE = MOCK;
const OTHER_SITE = `http://127.0.0.1:${CAMPAIGNS_MOCK_PORT}`;

/** Serves a stand-in Turnstile script that fills the response field with `token`. */
async function stubTurnstile(page: Page, token = TEST_TOKEN) {
  await page.route(`${TURNSTILE}*`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `for (const widget of document.querySelectorAll(".cf-turnstile")) {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = widget.dataset.responseFieldName || "cf-turnstile-response";
  input.value = ${JSON.stringify(token)};
  widget.appendChild(input);
}`,
    }),
  );
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page
      .getByRole("heading", { name: "Finish setting up" })
      .or(page.getByTestId("onboarding-complete")),
  ).toBeVisible();
}

async function apiPost(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`${BASE}/api${path}`, { data, headers: { Origin: BASE } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function apiPut(page: Page, path: string, data: unknown) {
  const res = await page.request.put(`${BASE}/api${path}`, { data, headers: { Origin: BASE } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

interface SentEmail {
  to: string | string[];
  subject: string;
  html: string;
}

async function sentTo(page: Page, email: string): Promise<SentEmail[]> {
  const sent = (await (await page.request.get(`${MOCK}/sent`)).json()) as SentEmail[];
  return sent.filter((item) => [item.to].flat().includes(email));
}

async function confirmLink(page: Page, email: string): Promise<string> {
  let link = "";
  await expect(async () => {
    const [mail] = await sentTo(page, email);
    link = /href="([^"]*\/f\/confirm\/[A-Za-z0-9_-]{43})"/.exec(mail?.html ?? "")?.[1] ?? "";
    expect(link).not.toBe("");
  }).toPass({ timeout: 10_000 });
  return link;
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude('iframe[data-testid="form-preview"]')
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }));
  expect(serious).toEqual([]);
}

test.describe("signup forms", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, viewport: { width: 1360, height: 1000 } });

  let hostedUrl = "";
  let snippet = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${BASE}/api/setup/owner`, {
      data: {
        token: SETUP_TOKEN,
        email: OWNER.email,
        name: OWNER.name,
        workspaceName: "Course Academy",
        password: OWNER.password,
      },
    });
    expect(res.status()).toBe(201);
  });

  test("the owner creates a form with a live preview, an embed snippet, and a hosted link", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    await signIn(page);
    await apiPost(page, "/connections", {
      provider: "resend",
      credentials: { apiKey: "re_e2e_key_123456" },
    });
    const domain = await apiPost(page, "/domains", { domain: "mail.example.com" });
    expect(domain.status).toBe("verified");
    await apiPost(page, "/lists", { name: "Course news" });
    // A campaign needs the postal address of the brand kit (U13).
    await apiPut(page, "/brand", {
      name: "",
      colorPrimary: "#4a3c77",
      colorAccent: "#ede9f8",
      font: "system",
      footer: "",
      address: "1 Course Street, Springfield",
      social: {},
    });
    await apiPost(page, "/fields", {
      key: "topics",
      label: "Topics",
      type: "multi",
      options: ["Design", "Data"],
    });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Forms" })
      .click();
    await expect(page.getByRole("heading", { name: "Forms" })).toBeVisible();
    await expect(page.getByTestId("turnstile-notice")).toHaveCount(0);
    await page.getByRole("button", { name: "New form" }).click();
    await expect(page.getByRole("heading", { name: "New form" })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Course news <b>weekly</b>");
    await page.getByLabel("Course news", { exact: true }).check();
    await page.getByLabel("Topics").check();
    // The preview follows the draft, at 360 px and at 640 px.
    const preview = page.frameLocator('iframe[data-testid="form-preview"]');
    await expect(preview.getByRole("heading", { name: "Course news <b>weekly</b>" })).toBeVisible();
    await expect(preview.getByText("Design")).toBeVisible();
    await expect(page.getByTestId("form-preview")).toHaveAttribute("width", "360");
    await page.getByRole("button", { name: "640 px" }).click();
    await expect(page.getByTestId("form-preview")).toHaveAttribute("width", "640");
    await page.getByLabel("Page state").selectOption("inbox");
    await expect(preview.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    // A wildcard origin is refused on save.
    await page.getByLabel("Websites that can embed the form").fill("https://*.example.com");
    await page.getByLabel("Form is on").check();
    await page.getByRole("button", { name: "Create form" }).click();
    await expect(page.getByText(/is not valid/)).toBeVisible();
    await page.getByLabel("Websites that can embed the form").fill(ALLOWED_SITE);
    await page.getByRole("button", { name: "Create form" }).click();
    await expect(page).toHaveURL(/\/forms\/\d+$/);
    await expect(page.getByRole("heading", { name: "Share and embed" })).toBeVisible();
    hostedUrl = (await page.getByTestId("hosted-link").textContent()) ?? "";
    snippet = (await page.getByTestId("embed-snippet").textContent()) ?? "";
    expect(hostedUrl).toMatch(new RegExp(`^${BASE}/f/[0-9a-f]{20}$`));
    expect(snippet).toContain(`src="${hostedUrl}?embed=1"`);
    expect(snippet).toMatch(/height="\d+"/);
    await expectNoSeriousViolations(page);
    checkCsp();
  });

  test("a visitor signs up on the hosted page, confirms from the email, and is subscribed (F1)", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    // The owner's session, for the API checks below.
    await signIn(page);
    await stubTurnstile(page);
    const response = await page.goto(hostedUrl);
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src https://challenges.cloudflare.com");
    expect(csp).toContain(`frame-ancestors 'self' ${ALLOWED_SITE}`);
    // The owner's text is plain text on the page.
    await expect(page.getByRole("heading", { name: "Course news <b>weekly</b>" })).toBeVisible();
    await expect(page.locator("b")).toHaveCount(0);
    await expect(page.getByText("I agree to get emails from this sender.")).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByLabel("Email address").fill("Reader@Example.org");
    await page.getByLabel("Data").check();
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    const link = await confirmLink(page, "reader@example.org");
    expect(link.startsWith(`${BASE}/f/confirm/`)).toBe(true);
    // The link opens a page with a button. Opening it does not subscribe.
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Confirm your subscription" })).toBeVisible();
    await page.goto(link);
    const pending = await page.request.get(`${BASE}/api/contacts`, {
      params: { search: "reader@example.org" },
    });
    expect(((await pending.json()) as { items: unknown[] }).items).toHaveLength(0);

    // The Confirm button works from the keyboard.
    await page.getByRole("button", { name: "Confirm" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "You are subscribed" })).toBeVisible();
    await expect(page.getByText("Thank you. Your subscription is active.")).toBeVisible();

    const contacts = await page.request.get(`${BASE}/api/contacts`, {
      params: { search: "reader@example.org" },
    });
    const [contact] = ((await contacts.json()) as { items: { id: number; consentBasis: string }[] })
      .items;
    expect(contact?.consentBasis).toBe("explicit_opt_in");
    const consent = await page.request.get(`${BASE}/api/contacts/${contact?.id}/consent`);
    const [event] = ((await consent.json()) as { items: { source: string; basis: string }[] })
      .items;
    expect(event).toMatchObject({ source: "form", basis: "explicit_opt_in" });
    checkCsp();
  });

  test("a failed bot check returns the form with an error and sends nothing", async ({ page }) => {
    const checkCsp = watchCsp(page);
    await stubTurnstile(page, "not-a-valid-token");
    await page.goto(hostedUrl);
    await page.getByLabel("Email address").fill("bot@example.org");
    await page.getByRole("button", { name: "Subscribe" }).click();
    const summary = page.getByRole("alert");
    await expect(summary).toContainText("We could not make sure that you are a person.");
    await expect(page.getByLabel("Email address")).toHaveValue("bot@example.org");
    expect(await sentTo(page, "bot@example.org")).toHaveLength(0);

    // A bad address shows the error summary, which takes the focus.
    await page.getByLabel("Email address").fill("not an address");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.locator("#errors")).toBeFocused();
    await expect(page.getByRole("link", { name: /Enter a valid email address/ })).toBeVisible();
    checkCsp();
  });

  test("the embed works on an allowed website and frame-ancestors blocks it on another", async ({
    page,
  }) => {
    const src = /src="([^"]*)"/.exec(snippet)?.[1] ?? "";
    const site = (origin: string) => `${origin}/embed?src=${encodeURIComponent(src)}`;
    await stubTurnstile(page);

    const checkAllowed = watchCsp(page);
    await page.goto(site(ALLOWED_SITE));
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Course news <b>weekly</b>" })).toBeVisible();
    await frame.getByLabel("Email address").fill("embedded@example.org");
    await frame.getByRole("button", { name: "Subscribe" }).click();
    await expect(frame.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await confirmLink(page, "embedded@example.org");
    checkAllowed();

    const blocked: string[] = [];
    page.on("console", (message) => {
      if (/frame-ancestors/.test(message.text())) blocked.push(message.text());
    });
    const checkOther = watchCsp(page);
    await page.goto(site(OTHER_SITE));
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    await expect(frame.getByRole("heading", { name: "Course news <b>weekly</b>" })).toHaveCount(0);
    // The only violation is the blocked frame.
    checkOther(/frame-ancestors/);
  });

  test("a second signup for the same address within the hour sends no second email", async ({
    page,
  }) => {
    await stubTurnstile(page);
    for (let i = 0; i < 2; i++) {
      await page.goto(hostedUrl);
      await page.getByLabel("Email address").fill("twice@example.org");
      await page.getByRole("button", { name: "Subscribe" }).click();
      await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    }
    await confirmLink(page, "twice@example.org");
    // Give the background work of the second submission time to finish.
    await page.waitForTimeout(1500);
    expect(await sentTo(page, "twice@example.org")).toHaveLength(1);
  });

  // Fields on forms and the preference page (plan U9, R14).
  test("a required field on the form, and the subscriber changes the answer on the preference page", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    await signIn(page);
    const field = (await apiPost(page, "/fields", {
      key: "frequency",
      label: "Frequency",
      type: "choice",
      options: ["Weekly", "Monthly"],
    })) as { id: number; options: { id: number; label: string }[] };
    const monthly = field.options[1]?.id;

    // The owner lets subscribers change the field on the preference page.
    await page.goto("/contacts/fields");
    const card = page.getByTestId("field-card").filter({ hasText: "Frequency" });
    await card.getByLabel("On the preference page").selectOption("editable");
    await expect(
      page.getByTestId("toast").getByText('The preference page setting of "Frequency" is saved.'),
    ).toBeVisible();
    await expectNoSeriousViolations(page);

    // The owner asks the field on the form, as a required answer.
    const forms = await page.request.get(`${BASE}/api/forms`);
    const [form] = ((await forms.json()) as { items: { id: number; listIds: number[] }[] }).items;
    await page.goto(`/forms/${form?.id}`);
    await page.getByRole("group", { name: "Fields to ask" }).getByLabel("Frequency").check();
    await page.getByRole("group", { name: "Required answers" }).getByLabel("Frequency").check();
    const preview = page.frameLocator('iframe[data-testid="form-preview"]');
    await expect(preview.getByText("(required)")).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.getByRole("button", { name: "Save form" }).click();
    await expect(
      page
        .getByTestId("toast")
        .getByText(/Form ".*" saved\./)
        .first(),
    ).toBeVisible();

    // Without an answer, the form shows an error and sends nothing.
    await stubTurnstile(page);
    await page.goto(hostedUrl);
    await page.getByLabel("Email address").fill("pref@example.org");
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.locator("#errors")).toBeFocused();
    await expect(page.getByRole("link", { name: "Select an option for Frequency." })).toBeVisible();
    expect(await sentTo(page, "pref@example.org")).toHaveLength(0);
    await page.getByLabel("Weekly").check();
    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await page.goto(await confirmLink(page, "pref@example.org"));
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { name: "You are subscribed" })).toBeVisible();

    // A campaign email gives the subscriber a link to the preference page.
    const template = await apiPost(page, "/templates", {
      name: "Frequency news",
      subject: "Frequency news",
      format: "html",
      source:
        '<html><body><p>News.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>',
    });
    const draft = await apiPost(page, "/campaigns", {
      name: "Frequency news",
      templateId: template.id,
      fromName: "Course Academy",
      fromEmail: "news@mail.example.com",
      audience: { listIds: form?.listIds },
    });
    const prepared = await apiPost(page, `/campaigns/${draft.id}/prepare`, { mode: "send_now" });
    expect(prepared.blocked, JSON.stringify(prepared.checklist)).toBe(false);
    await apiPost(page, `/campaigns/${draft.id}/confirm`, { token: prepared.token });
    let preferences = "";
    await expect(async () => {
      const sent = (await (await page.request.get(`${MOCK}/sent`)).json()) as {
        to: string | string[];
        subject: string;
        headers?: Record<string, string>;
      }[];
      const mail = sent.find(
        (item) =>
          [item.to].flat().includes("pref@example.org") && item.subject === "Frequency news",
      );
      const url = mail?.headers?.["List-Unsubscribe"]?.slice(1, -1) ?? "";
      expect(url).toMatch(/\/u\//);
      preferences = `${BASE}${new URL(url).pathname}`;
    }).toPass({ timeout: 20_000 });

    // The subscriber sees the answer of the form and changes it.
    await page.goto(preferences);
    await expect(page.getByRole("heading", { name: "Email preferences" })).toBeVisible();
    const group = page.getByRole("group", { name: "Frequency" });
    await expect(group.getByLabel("Weekly")).toBeChecked();
    await expectNoSeriousViolations(page);
    await group.getByLabel("Monthly").check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Your choices are saved.")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Frequency" }).getByLabel("Monthly"),
    ).toBeChecked();

    const contacts = await page.request.get(`${BASE}/api/contacts`, {
      params: { search: "pref@example.org" },
    });
    const [contact] = ((await contacts.json()) as { items: { id: number }[] }).items;
    const detail = await page.request.get(`${BASE}/api/contacts/${contact?.id}`);
    expect(
      ((await detail.json()) as { fields: Record<string, string | null> }).fields,
    ).toMatchObject({
      frequency: String(monthly),
    });
    checkCsp();
  });
});
