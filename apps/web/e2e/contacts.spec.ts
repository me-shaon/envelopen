import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { CONTACTS_PORT } from "../playwright.config";

// Contacts and CSV import (plan U6), against their own fresh Worker. The tests run in
// order on one owner: import a CSV through the UI, then work with the contacts.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };

const CSV = [
  "Email,First name,Last name,Course",
  "Ana.Silva@Example.com ,Ana,Silva,Intro to Data",
  "ben@example.com,Ben,Okafor,Intro to Data",
  '"chen@example.com","Chen","Li, Jr.","Intro to Data"',
  "not-an-email,Nobody,,",
  "ana.silva@example.com,Ana,Again,",
].join("\r\n");

async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
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

test.describe("contacts", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://localhost:${CONTACTS_PORT}` });

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`http://localhost:${CONTACTS_PORT}/api/setup/owner`, {
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

  test("imports a CSV through the UI and shows the contacts", async ({ page }) => {
    await signIn(page);
    const step = page.getByTestId("onboarding-step-import_contacts");
    await expect(step).toHaveAttribute("data-status", "todo");
    await step.getByRole("link", { name: "Import CSV" }).click();
    await expect(page.getByText("No contacts yet")).toBeVisible();
    await page.getByRole("link", { name: "Import a CSV" }).click();

    // Upload.
    await expect(page.getByRole("heading", { name: "Import contacts" })).toBeVisible();
    await page.locator("#csv-file").setInputFiles({
      name: "students.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`﻿${CSV}`),
    });

    // Map the columns. The guess maps email and names. The course becomes a custom field.
    await expect(page.getByRole("heading", { name: "Map the columns" })).toBeVisible();
    await expect(page.getByLabel("Import Email as")).toHaveValue("email");
    await expect(page.getByLabel("Import Last name as")).toHaveValue("last_name");
    await page.getByLabel("Import Course as").selectOption("field:course");
    await page.getByRole("button", { name: "Continue" }).click();

    // The consent basis is required.
    const preview = page.getByRole("button", { name: "Preview the import" });
    await expect(preview).toBeDisabled();
    await page.getByRole("radio", { name: /Existing customer/ }).check();
    await page.getByLabel("Tags").fill("Intro to Data");
    await preview.click();

    // Preview counts.
    await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("count-new")).toContainText("3");
    await expect(page.getByTestId("count-invalid")).toContainText("1");
    await expect(page.getByTestId("count-duplicate")).toContainText("1");
    await expect(page.getByTestId("count-skippedSuppressed")).toContainText("0");
    await expectNoSeriousViolations(page);
    await screenshot(page, "import-preview");

    // Import, then download the error file.
    await page.getByRole("button", { name: "Import 3 contacts" }).click();
    await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible({
      timeout: 30_000,
    });
    await screenshot(page, "import-complete");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download the error file/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("students-errors.csv");
    const errors = await download.createReadStream();
    let text = "";
    for await (const chunk of errors) text += chunk;
    expect(text).toContain("4,not-an-email,Not a valid email address");
    expect(text).toContain("5,ana.silva@example.com,Duplicate of an earlier row");

    // The contacts.
    await page.getByRole("link", { name: "View contacts" }).click();
    await expect(page.getByTestId("contact-row")).toHaveCount(3);
    await expect(page.getByTestId("contacts-total")).toHaveText("3");
    await expect(page.getByRole("link", { name: /ana\.silva@example\.com/ })).toBeVisible();
    await expect(page.getByTestId("contact-row").first()).toContainText("Intro to Data");
    await expectNoSeriousViolations(page);
    await screenshot(page, "contacts-list");
  });

  test("shows consent history and keeps an unsubscribed contact visible", async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId("onboarding-step-import_contacts")).toHaveAttribute(
      "data-status",
      "done",
    );
    await page.goto("/contacts");
    await page.getByRole("link", { name: /chen@example\.com/ }).click();
    await expect(page.getByRole("heading", { name: "chen@example.com" })).toBeVisible();
    await expect(page.getByText("Li, Jr.")).toBeVisible();
    const history = page.getByRole("list", { name: "Consent events" });
    await expect(history).toContainText("Existing customer");
    await expect(history).toContainText("Import #1");
    await expect(page.getByRole("button", { name: "Remove tag Intro to Data" })).toBeVisible();

    await page.getByRole("button", { name: "Unsubscribe from all" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText("Unsubscribed from every list")).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "contact-unsubscribed");

    await page.getByRole("link", { name: "Contacts" }).first().click();
    // The search updates as you type, without Enter.
    const search = page.getByLabel("Search by email or name");
    await search.fill("chen");
    await expect(page.getByTestId("contact-row")).toHaveCount(1);
    await expect(page).toHaveURL(/search=chen/);
    await search.fill("");
    await expect(page.getByTestId("contact-row")).toHaveCount(3);
    await page.getByLabel("Status").selectOption("unsubscribed");
    await expect(page.getByTestId("contact-row")).toHaveCount(1);
    await expect(page.getByTestId("contact-row")).toContainText("Unsubscribed");

    // Export the filtered contacts.
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create export" }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download CSV" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    let csv = "";
    for await (const chunk of await download.createReadStream()) csv += chunk;
    expect(csv).toContain('chen@example.com,Chen,"Li, Jr.",unsubscribed,existing_customer');
    expect(csv).not.toContain("ben@example.com");
    await page.keyboard.press("Escape");

    // Lists, tags, and the suppression list.
    await page.getByRole("link", { name: "Tags" }).click();
    await expect(page.getByTestId("tag-row")).toContainText("Intro to Data");
    await page.getByRole("link", { name: "Lists" }).click();
    await page.getByLabel("New list").fill("Newsletter");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByTestId("list-row")).toContainText("Newsletter");
    await page.getByRole("link", { name: "Suppression list" }).click();
    await page.getByLabel("Block addresses").fill("ben@example.com");
    await page.getByRole("button", { name: /Suppress 1 address/ }).click();
    await expect(page.getByTestId("suppression-row")).toContainText("ben@example.com");
    await expectNoSeriousViolations(page);
  });

  test("removes a tag without a question and puts it back with Undo", async ({ page }) => {
    await signIn(page);
    await page.goto("/contacts");
    await page.getByRole("link", { name: /ben@example\.com/ }).click();
    await expect(page.getByRole("heading", { name: "ben@example.com" })).toBeVisible();
    await page.getByRole("button", { name: "Remove tag Intro to Data" }).click();
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText('Tag "Intro to Data" removed from ben@example.com.');
    await expect(page.getByRole("button", { name: "Remove tag Intro to Data" })).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Remove tag Intro to Data" })).toBeVisible();
  });

  // Motion on: the loading skeleton, its replacement by content, and a toast.
  test.describe("with motion", () => {
    test.use({ reducedMotion: "no-preference" });

    test("shows a skeleton while the contacts load, then the rows", async ({ page }) => {
      await signIn(page);
      // Hold the contact list for a moment, so the skeleton has time to show.
      const contactList = (url: URL) => url.pathname === "/api/contacts";
      await page.route(contactList, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.continue();
      });
      await page.getByRole("link", { name: "Contacts" }).first().click();
      const skeleton = page.getByRole("status", { name: "Loading the contacts" });
      await expect(skeleton).toBeVisible();
      await expect(skeleton).toHaveAttribute("aria-busy", "true");
      await expect(page.getByTestId("contact-row").first()).toBeVisible();
      await expect(skeleton).toHaveCount(0);
      await page.unroute(contactList);

      // A tag added on a contact fades in. A removed tag fades out, and a toast offers Undo.
      await page.getByRole("link", { name: /ana\.silva@example\.com/ }).click();
      await page.getByLabel("New tag").fill("Alumni");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove tag Alumni" })).toBeVisible();
      await page.getByRole("button", { name: "Remove tag Alumni" }).click();
      await expect(page.getByTestId("toast")).toContainText('Tag "Alumni" removed');
      await expect(page.getByRole("button", { name: "Remove tag Alumni" })).toHaveCount(0);
      await expectNoSeriousViolations(page);
    });
  });
});
