import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CAMPAIGNS_MOCK_PORT, CAMPAIGNS_PORT } from "../playwright.config";

// The campaign engine (plan U9), against its own fresh Worker with a local D1, Queue,
// Workflow, and Durable Objects. The Worker sends provider and DNS requests to its own
// instance of e2e/provider-mock.mjs, which also serves the DMARC record, so the sending
// domain verifies. The campaign goes to test addresses through the mock Resend.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${CAMPAIGNS_PORT}`;
const MOCK = `http://127.0.0.1:${CAMPAIGNS_MOCK_PORT}`;
const TEMPLATE_HTML =
  '<html><body><p>Hello {{ first_name | default: "there" }},</p>' +
  '<p>The new course starts on Monday. <a href="https://example.com/course">See the course</a>.</p>' +
  '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>';

/** A viewport screenshot from the top of the page. */
async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // The click map shows the email itself, which the owner writes. Axe checks the app.
    .exclude('iframe[title="Email with clicks per link"]')
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }));
  expect(serious).toEqual([]);
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Once every setup step is done, the checklist folds into one line.
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

test.describe("campaigns", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, viewport: { width: 1360, height: 1000 } });

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

  test("creates a campaign to test addresses, confirms it, and sees it reach sent", async ({
    page,
    request,
  }) => {
    await signIn(page);
    // The setup that earlier units cover: a provider, a verified domain, a list of two
    // test contacts, and a template with an unsubscribe link.
    await apiPost(page, "/connections", {
      provider: "resend",
      credentials: { apiKey: "re_e2e_key_123456" },
    });
    const domain = await apiPost(page, "/domains", { domain: "mail.example.com" });
    expect(domain.status).toBe("verified");
    const list = await apiPost(page, "/lists", { name: "Course testers" });
    for (const [email, firstName] of [
      [OWNER.email, "Ada"],
      ["tester@example.com", "Grace"],
    ]) {
      await apiPost(page, "/contacts", {
        email,
        firstName,
        consentBasis: "existing_customer",
        listIds: [list.id],
      });
    }
    await apiPost(page, "/templates", {
      name: "Course launch",
      subject: "A new course for {{ first_name }}",
      format: "html",
      source: TEMPLATE_HTML,
    });

    // The overview's header button starts a campaign.
    await page.getByRole("link", { name: "New campaign" }).first().click();
    await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible();
    await page.getByLabel("Campaign name").fill("Course launch, test run");
    await page.getByLabel("Template").selectOption({ label: "Course launch" });
    await page.getByLabel("Preview text").fill("It starts on Monday");
    await page.getByLabel("From name").fill("Course Academy");
    await page.getByLabel("From address").fill("news@mail.example.com");
    await page.getByLabel("Course testers").check();
    await page.getByRole("button", { name: "Create draft" }).click();

    await expect(page).toHaveURL(/\/campaigns\/\d+$/);
    await expect(page.getByTestId("draft-estimate")).toHaveText("2");
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Review and send" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Check and continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Confirm the send" })).toBeVisible();
    await expect(dialog.getByTestId("estimate")).toHaveText("2");
    await expect(dialog.getByText("Recipients (estimate)")).toBeVisible();
    await expect(dialog.getByText("Resend", { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-testid="checklist-item"][data-status="fail"]')).toHaveCount(
      0,
    );
    await expectNoSeriousViolations(page);
    await screenshot(page, "confirm-dialog");

    await dialog.getByRole("button", { name: "Send to about 2 people" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("kpi-sent")).toContainText("2");
    await expect(page.getByTestId("kpi-uncertain")).toContainText("0");
    await expectNoSeriousViolations(page);
    await screenshot(page, "campaign-view");

    // The mock provider got one email per recipient, with both unsubscribe headers.
    const sent = (await (await request.get(`${MOCK}/sent`)).json()) as {
      to: string[];
      subject: string;
      headers: Record<string, string>;
    }[];
    const campaign = sent.filter((email) => email.subject.startsWith("A new course"));
    expect(campaign.map((email) => email.to[0]).sort()).toEqual([
      OWNER.email,
      "tester@example.com",
    ]);
    expect(campaign.map((email) => email.subject).sort()).toEqual([
      "A new course for Ada",
      "A new course for Grace",
    ]);
    for (const email of campaign) {
      expect(email.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/[^>]+\/u\/[^>]+>$/);
      expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }

    // The campaign shows on the list and on the overview.
    await page.getByRole("link", { name: "Campaigns", exact: true }).first().click();
    await expect(page.getByTestId("campaign-row")).toContainText("Course launch, test run");
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Recent campaigns" })).toContainText("Sent");
  });

  // Tracking and unsubscribe (plan U10) on the campaign that the test above sent.
  test("tracks an open and a click, unsubscribes in one click and on the page, and shows both contacts as unsubscribed", async ({
    page,
    request,
  }) => {
    const sent = (await (await request.get(`${MOCK}/sent`)).json()) as {
      to: string[];
      subject: string;
      html: string;
      headers: Record<string, string>;
    }[];
    const byRecipient = (email: string) => {
      const found = sent.find(
        (item) => item.to[0] === email && item.subject.startsWith("A new course"),
      );
      if (!found) throw new Error(`No campaign email to ${email}.`);
      return found;
    };
    // The links point at the https app host. The local Worker serves the same paths.
    const local = (url: string) => {
      const parsed = new URL(url);
      return `${BASE}${parsed.pathname}${parsed.search}`;
    };
    const tester = byRecipient("tester@example.com");

    // The open pixel answers with the image.
    const pixelUrl = /src="([^"]+\/t\/o\/[^"]+)"/.exec(tester.html)?.[1];
    expect(pixelUrl).toBeDefined();
    const pixel = await request.get(local(pixelUrl as string));
    expect(pixel.status()).toBe(200);
    expect(pixel.headers()["content-type"]).toBe("image/gif");

    // The click goes to the stored URL.
    const clickUrl = /href="([^"]+\/t\/c\/[^"]+)"/.exec(tester.html)?.[1];
    expect(clickUrl).toBeDefined();
    const click = await request.get(local(clickUrl as string), { maxRedirects: 0 });
    expect(click.status()).toBe(302);
    expect(click.headers().location).toBe("https://example.com/course");

    // RFC 8058 one-click: a form POST to the List-Unsubscribe URL, with no redirect.
    const listUnsubscribe = tester.headers["List-Unsubscribe"]?.slice(1, -1) ?? "";
    const oneClick = await request.post(local(listUnsubscribe), {
      form: { "List-Unsubscribe": "One-Click" },
      maxRedirects: 0,
    });
    expect(oneClick.status()).toBe(200);
    expect(await oneClick.text()).toContain("You are unsubscribed");

    // The owner uses the preference page from the footer link, without JavaScript.
    const owner = byRecipient(OWNER.email);
    const footer = /href="([^"]+\/u\/[^"]+)"/.exec(owner.html)?.[1];
    expect(footer).toBeDefined();
    const browser = page.context().browser();
    if (!browser) throw new Error("No browser.");
    const noScript = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1360, height: 1000 },
    });
    // Axe and the screenshots run scripts, so they look at the same pages in a second
    // context. A GET of these pages changes nothing.
    const inspector = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1360, height: 1000 },
    });
    const inspect = async (url: string, name: string) => {
      const view = await inspector.newPage();
      await view.goto(url);
      await expectNoSeriousViolations(view);
      await screenshot(view, name);
      await view.close();
    };
    const publicPage = await noScript.newPage();
    await publicPage.goto(local(footer as string));
    await expect(publicPage.getByRole("heading", { name: "Email preferences" })).toBeVisible();
    await expect(publicPage.getByRole("checkbox", { name: "Course testers" })).toBeChecked();
    await inspect(publicPage.url(), "preference-page");
    await publicPage.getByRole("link", { name: "Unsubscribe from all" }).click();
    await expect(
      publicPage.getByRole("heading", { name: "Unsubscribe from all emails?" }),
    ).toBeVisible();
    await publicPage.getByRole("button", { name: "Unsubscribe from all" }).click();
    await expect(publicPage.getByRole("heading", { name: "You are unsubscribed" })).toBeVisible();
    await expect(publicPage.getByRole("button", { name: "Subscribe again" })).toBeVisible();
    await inspect(publicPage.url(), "unsubscribed-state");
    await noScript.close();
    await inspector.close();

    // The owner sees both contacts as unsubscribed, with the source and the campaign.
    await page.goto("/login");
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByRole("link", { name: "Contacts" }).first().click();
    const rows = page.getByTestId("contact-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "tester@example.com" })).toContainText("Unsubscribed");
    await expect(rows.filter({ hasText: OWNER.email })).toContainText("Unsubscribed");
    await page.getByRole("link", { name: /tester@example\.com/ }).click();
    await expect(page.getByText("Unsubscribed from every list")).toBeVisible();
    await expect(page.getByText(/One-click unsubscribe, campaign #\d+/)).toBeVisible();
  });

  // Stats, usage, and follow-up (plan U11), from the open, the click, and the two
  // unsubscribes above. The Worker flushes tracking events after one second in these
  // tests (EVENT_FLUSH_DELAY_MS in e2e/serve.mjs), so a reload shows them.
  test("shows the open, the scanner click, and the unsubscribes in the stats, the overview, and the usage view", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Campaigns", exact: true }).first().click();
    await page.getByRole("link", { name: "Course launch, test run" }).click();
    await expect(page).toHaveURL(/\/campaigns\/\d+$/);
    const campaignUrl = page.url();

    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("stat-opened")).toContainText("1 contact", { timeout: 2000 });
      await expect(page.getByTestId("stat-unsubscribed")).toContainText("2 contacts", {
        timeout: 2000,
      });
      await expect(page.getByText("1 click by link scanners is left out.")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("stat-opened")).toContainText("50.0%");
    // The test clicked seconds after the send, inside the bot window (KTD29), so the
    // click counts as a scanner's and stays out of the human numbers.
    await expect(page.getByTestId("stat-clicked")).toContainText("0 contacts");
    await expect(page.getByTestId("stat-click-to-open")).toContainText("0.0%");
    // Resend sends delivery events, so delivered is a number. The mock sent none.
    await expect(page.getByTestId("stat-delivered")).toContainText("0 inboxes");
    await expect(page.getByTestId("engagement-chart")).toContainText(
      "1 open and 0 clicks by people in the first hour",
    );
    await expect(page.getByTestId("click-map-link")).toHaveCount(1);
    await expect(page.getByTestId("click-map-link")).toContainText("https://example.com/course");
    await expect(page.getByTitle("Email with clicks per link")).toHaveAttribute("sandbox", "");
    const email = page.frameLocator('iframe[title="Email with clicks per link"]');
    await expect(email.getByRole("link", { name: "See the course" })).toHaveAttribute(
      "data-envelopen-link",
      "0",
    );
    await expect(email.getByText("Hello Ada")).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "campaign-stats");

    // The overview shows the same numbers for the latest campaign.
    await page.getByRole("link", { name: "Overview" }).first().click();
    const latest = page.getByRole("region", { name: "Course launch, test run" });
    await expect(latest.getByTestId("stat-opened")).toContainText("1 contact");
    await expect(latest.getByRole("link", { name: "Full report" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "overview-with-data");

    // The sidebar card opens the usage view with the measured D1 writes.
    await page.getByTestId("usage-card").first().click();
    await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
    await expect(page.getByTestId("usage-used")).not.toHaveText("0");
    await expect(page.getByRole("cell", { name: "Not measured" }).first()).toBeVisible();
    await expect(page.getByText("00:00 UTC", { exact: true })).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "usage");

    // A follow-up is a draft that leaves out the person who opened. The other contact
    // unsubscribed from everything, so nobody is left to send to.
    await page.goto(campaignUrl);
    await page.getByRole("button", { name: "Create follow-up draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Course launch, test run (follow-up)" }),
    ).toBeVisible();
    await expect(page.getByText(/to non-openers of campaign #\d+/)).toBeVisible();
    await expect(page.getByTestId("draft-estimate")).toHaveText("0");
  });
});
