import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { FIRST_CAMPAIGN_MOCK_PORT, FIRST_CAMPAIGN_PORT } from "../playwright.config";

// The first-campaign flow F1 (plan U17), through the UI only, against its own fresh
// Worker with a local D1, Queue, Workflows, and Durable Objects. The Worker sends
// provider and DNS requests to its own instance of e2e/provider-mock.mjs, which also
// serves the DMARC record, so the sending domain verifies. Then the data rights of one
// contact (export and erase) and the audit log that records them.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const STUDENT = "grace@example.com";
const BASE = `http://localhost:${FIRST_CAMPAIGN_PORT}`;
const MOCK = `http://127.0.0.1:${FIRST_CAMPAIGN_MOCK_PORT}`;
const CSV = `Email,First name\r\n${OWNER.email},Ada\r\n${STUDENT},Grace\r\n`;

interface SentEmail {
  to: string[];
  subject: string;
  html: string;
  headers: Record<string, string>;
}

/** A viewport screenshot from the top of the page. */
async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // The email previews show the email itself, which the owner writes. Axe checks the app.
    .exclude('iframe[title="Email preview"]')
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
  await expect(page).not.toHaveURL(/\/login/);
}

async function sentEmails(page: Page): Promise<SentEmail[]> {
  return (await (await page.request.get(`${MOCK}/sent`)).json()) as SentEmail[];
}

test.describe("first campaign", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, viewport: { width: 1360, height: 1000 } });

  test("F1: sets up, connects, verifies, imports, tests, sends, and sees the stats", async ({
    page,
  }) => {
    // First-run setup.
    await page.goto("/setup");
    await page.getByLabel("Setup token").fill(SETUP_TOKEN);
    await page.getByRole("button", { name: "Check the deployment" }).click();
    await expect(page.getByText("9 of 9 pass")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Your name").fill(OWNER.name);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByLabel("First workspace").fill("Course Academy");
    await page.getByRole("button", { name: "Create the owner" }).click();
    await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();

    // Connect a provider with one field.
    await page
      .getByTestId("onboarding-step-connect_provider")
      .getByRole("link", { name: "Connect a provider", exact: true })
      .click();
    await page.getByRole("button", { name: "Connect Resend" }).click();
    const connect = page.getByRole("dialog");
    await connect.getByLabel("API key").fill("re_e2e_key_123456");
    await connect.getByRole("button", { name: "Connect" }).click();
    const card = page.locator('[data-testid="connection-card"][data-provider="resend"]');
    await expect(card).toContainText("Connected");
    await expect(card).toContainText("Sends your email");

    // Add and verify the sending domain. The mock DNS has SPF, DKIM, and DMARC.
    await page.goto("/");
    await page
      .getByTestId("onboarding-step-verify_domain")
      .getByRole("link", { name: "Add a domain", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Sending domain" }).fill("mail.example.com");
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByRole("heading", { name: "mail.example.com" })).toBeVisible();
    for (const check of ["spf", "dkim", "dmarc"]) {
      await expect(page.getByTestId(`check-${check}`)).toHaveAttribute("data-status", "pass");
    }

    // Import a CSV with a consent basis and a tag.
    await page.goto("/contacts/import");
    await page.locator("#csv-file").setInputFiles({
      name: "students.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    await expect(page.getByRole("heading", { name: "Map the columns" })).toBeVisible();
    await expect(page.getByLabel("Import Email as")).toHaveValue("email");
    await expect(page.getByLabel("Import First name as")).toHaveValue("first_name");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Existing customer/ }).check();
    await page.getByLabel("Tags").fill("Course 101");
    await page.getByRole("button", { name: "Preview the import" }).click();
    await expect(page.getByTestId("count-new")).toContainText("2", { timeout: 30_000 });
    await page.getByRole("button", { name: "Import 2 contacts" }).click();
    await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible({
      timeout: 30_000,
    });

    // Create a template from blocks, with a link to click.
    await page.getByRole("link", { name: "Templates" }).first().click();
    await page.getByRole("button", { name: "New template" }).click();
    await page.getByLabel("Template name").fill("Course launch");
    await page.getByLabel("Subject").fill("A new course for {{ first_name }}");
    await page.getByRole("button", { name: "Add button" }).click();
    const settings = page.getByTestId("block-settings");
    await settings.getByLabel("Label").fill("See the course");
    await settings.getByLabel("Link").fill("https://example.com/course");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");

    // Send a test to the owner.
    await page.getByRole("button", { name: "Send test" }).click();
    const testDialog = page.getByRole("dialog", { name: "Send a test" });
    await expect(testDialog.getByLabel(OWNER.email)).toBeChecked();
    await testDialog.getByRole("button", { name: "Send test" }).click();
    await expect(testDialog.getByRole("status")).toContainText("Sent");
    await testDialog.getByRole("button", { name: "Close" }).first().click();
    const tests = (await sentEmails(page)).filter((email) => email.subject.startsWith("[Test]"));
    expect(tests.map((email) => email.to)).toEqual([[OWNER.email]]);

    // Every setup step is done, so the checklist folds into one line.
    await page.goto("/");
    const complete = page.getByTestId("onboarding-complete");
    await expect(complete).toContainText("Setup complete.");
    await expect(page.getByTestId("onboarding-step-send_test")).toBeHidden();
    await complete.getByRole("button", { name: "Show the steps" }).click();
    await expect(page.getByTestId("onboarding-step-send_test")).toHaveAttribute(
      "data-status",
      "done",
    );
    // The activity panel shows the audit log, newest first.
    const activity = page.getByTestId("recent-activity");
    await expect(activity.getByRole("listitem").first()).toContainText("Test email sent.");
    await expect(activity).toContainText("Email provider connected.");

    // Create the campaign to the tag, confirm, and wait for sent.
    await page.getByRole("link", { name: "New campaign" }).first().click();
    await page.getByLabel("Campaign name").fill("Course launch");
    await page.getByLabel("Template").selectOption({ label: "Course launch" });
    await page.getByLabel("From name").fill("Course Academy");
    await page.getByLabel("From address").fill("news@mail.example.com");
    await page.getByRole("checkbox", { name: "Course 101" }).first().check();
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page).toHaveURL(/\/campaigns\/\d+$/);
    await expect(page.getByTestId("draft-estimate")).toHaveText("2");

    await page.getByRole("button", { name: "Review and send" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: "Check and continue" }).click();
    await expect(confirm.getByRole("heading", { name: "Confirm the send" })).toBeVisible();
    await expect(confirm.locator('[data-testid="checklist-item"][data-status="fail"]')).toHaveCount(
      0,
    );
    await confirm.getByRole("button", { name: "Send to about 2 people" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("kpi-sent")).toContainText("2");

    // The student opens and clicks, through the links of the email that the mock got.
    const email = (await sentEmails(page)).find(
      (item) => item.to[0] === STUDENT && item.subject === "A new course for Grace",
    );
    expect(email?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const local = (url: string) => {
      const parsed = new URL(url);
      return `${BASE}${parsed.pathname}${parsed.search}`;
    };
    const pixelUrl = /src="([^"]+\/t\/o\/[^"]+)"/.exec(email?.html ?? "")?.[1];
    const clickUrl = /href="([^"]+\/t\/c\/[^"]+)"/.exec(email?.html ?? "")?.[1];
    expect(pixelUrl).toBeDefined();
    expect(clickUrl).toBeDefined();
    expect((await page.request.get(local(pixelUrl as string))).status()).toBe(200);
    const click = await page.request.get(local(clickUrl as string), { maxRedirects: 0 });
    expect(click.headers().location).toBe("https://example.com/course");

    // The stats show the open. The click came seconds after the send, inside the bot
    // window (KTD29), so it counts as a link scanner's.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("stat-opened")).toContainText("1 contact", { timeout: 2000 });
      await expect(page.getByText("1 click by link scanners is left out.")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("stat-opened")).toContainText("50.0%");
    await expectNoSeriousViolations(page);
  });

  test("exports and erases a contact, and the audit log records both", async ({ page }) => {
    await signIn(page);
    await page.goto("/contacts");
    await page.getByRole("link", { name: new RegExp(STUDENT.replaceAll(".", "\\.")) }).click();
    await expect(page.getByRole("heading", { name: STUDENT })).toBeVisible();

    // Export data downloads JSON with the contact, consent, the campaign, and the open.
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export data" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^contact-\d+\.json$/);
    let text = "";
    for await (const chunk of await download.createReadStream()) text += chunk;
    const data = JSON.parse(text) as {
      contact: { email: string; tags: { name: string }[] };
      consentEvents: { basis: string }[];
      campaigns: { campaignName: string; openedAt: number | null }[];
      events: { type: string }[];
    };
    expect(data.contact.email).toBe(STUDENT);
    expect(data.contact.tags.map((tag) => tag.name)).toEqual(["Course 101"]);
    expect(data.consentEvents.map((event) => event.basis)).toEqual(["existing_customer"]);
    expect(data.campaigns).toEqual([
      expect.objectContaining({ campaignName: "Course launch", openedAt: expect.any(Number) }),
    ]);
    expect(data.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["open", "click"]),
    );

    // Erase sits in the danger zone at the end of the page, and needs the typed address.
    const danger = page.getByRole("region", { name: "Danger zone" });
    await expect(danger).toContainText("You cannot undo it.");
    await danger.getByRole("button", { name: "Erase contact" }).click();
    const dialog = page.getByRole("dialog", { name: "Erase this contact?" });
    const erase = dialog.getByRole("button", { name: "Erase contact" });
    await expect(erase).toBeDisabled();
    await dialog.getByLabel(`Type ${STUDENT} to confirm`).fill("someone@example.com");
    await expect(erase).toBeDisabled();
    await dialog.getByLabel(`Type ${STUDENT} to confirm`).fill(STUDENT);
    await expect(erase).toBeEnabled();
    await expectNoSeriousViolations(page);
    await screenshot(page, "contact-erase-dialog");
    await erase.click();
    await expect(page).toHaveURL(/\/contacts$/);
    await expect(page.getByTestId("contact-row")).toHaveCount(1);
    await expect(page.getByRole("link", { name: /grace@example\.com/ })).toHaveCount(0);

    // A re-import of the address stays suppressed.
    const upsert = await page.request.post(`${BASE}/api/contacts`, {
      data: { email: STUDENT },
      headers: { Origin: BASE },
    });
    expect(upsert.ok()).toBe(true);
    expect(((await upsert.json()) as { contact: { status: string } }).contact.status).toBe(
      "suppressed",
    );

    // The audit log shows the export and the erase as sentences, with the raw action
    // key, the owner's name, and the UI surface.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("link", { name: "Open the audit log" }).click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    const rows = page.getByTestId("audit-row");
    const erased = rows.filter({ hasText: "contacts.erase" });
    await expect(erased).toContainText("Contact erased");
    await expect(erased).toContainText(OWNER.name);
    await expect(erased).toContainText("UI");
    await expect(rows.filter({ hasText: "contacts.export" })).toContainText(
      "Contact data exported",
    );
    // A target that still exists links to its record, with its name.
    const created = rows.filter({ hasText: "campaigns.create" });
    await expect(created.getByRole("link", { name: /Course launch/ })).toHaveAttribute(
      "href",
      /\/campaigns\/\d+$/,
    );
    await expect(rows.filter({ hasText: "contacts.export" })).toHaveCount(1);
    await expectNoSeriousViolations(page);
    await screenshot(page, "audit-log");

    await page.getByLabel("Action").selectOption("contacts.erase");
    await expect(rows).toHaveCount(1);
    await page.getByLabel("Surface").selectOption("mcp");
    await expect(page.getByText("No entries match the filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows.filter({ hasText: "connections.create" })).toHaveCount(1);
  });
});
