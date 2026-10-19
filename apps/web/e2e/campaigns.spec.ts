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
  const results = await new AxeBuilder({ page }).analyze();
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
  await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
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
});
