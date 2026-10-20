import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { EDITOR_MOCK_PORT, EDITOR_PORT } from "../playwright.config";
import { watchCsp } from "./csp";

// The template editor (plan U8), against its own fresh Worker. That Worker sends
// provider requests to its own instance of the mock in e2e/provider-mock.mjs, so the
// test send from the editor reaches a fake Resend. The tests run in order on one owner.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${EDITOR_PORT}`;
const MOCK = `http://127.0.0.1:${EDITOR_MOCK_PORT}`;

/**
 * Raw HTML that would mark the page if it ran: a script, an event handler, and a
 * javascript: link. The marker paragraph shows that the rest of the HTML renders.
 */
const HOSTILE_HTML =
  '<p id="marker">Safe content</p>' +
  "<script>document.body.setAttribute('data-ran', 'script')</script>" +
  `<img src="https://example.invalid/x.png" onerror="document.body.setAttribute('data-ran', 'onerror')">` +
  "<a id=\"js-link\" href=\"javascript:document.body.setAttribute('data-ran', 'link')\">Link</a>";

async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // The preview is the email itself, which the owner writes. Axe checks the app.
    .exclude('iframe[title="Email preview"]')
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
  await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
}

/** A same-origin API call with the session cookie, as the app makes it. */
async function apiPost(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`${BASE}/api${path}`, {
    data,
    headers: { Origin: BASE },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function apiGet(page: Page, path: string) {
  const res = await page.request.get(`${BASE}/api${path}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

function preview(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Email preview"]');
}

/** The preview iframe has an empty sandbox, and nothing in it ran. */
async function expectInertPreview(page: Page) {
  const iframe = page.locator('iframe[title="Email preview"]');
  await expect(iframe).toHaveAttribute("sandbox", "");
  const frame = preview(page);
  await expect(frame.locator("#marker")).toHaveText("Safe content");
  // Give a script time to run, then check that it did not.
  await page.waitForTimeout(300);
  await frame
    .locator("#js-link")
    .click({ force: true })
    .catch(() => undefined);
  await expect(frame.locator("body")).not.toHaveAttribute("data-ran", /.*/);
  expect(await page.evaluate(() => document.body.getAttribute("data-ran"))).toBeNull();
}

test.describe("editor", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE });

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

  test("creates a template from blocks, saves a block, and previews it without running scripts", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    await signIn(page);
    await page.getByRole("link", { name: "Templates" }).click();
    await expect(page.getByText("No templates yet")).toBeVisible();
    await page.getByRole("button", { name: "New template" }).click();

    await page.getByLabel("Template name").fill("Welcome email");
    await page.getByLabel("Subject").fill("Welcome, {{ first_name }}");
    await page.getByLabel("Preheader").fill("Your course starts on Monday");

    // A button block, edited in the settings panel.
    await page.getByRole("button", { name: "Add button" }).click();
    const settings = page.getByTestId("block-settings");
    await settings.getByLabel("Label").fill("Start the course");
    await settings.getByLabel("Link").fill("https://example.com/start");
    await expect(page.locator('[data-block="button"]')).toContainText("Start the course");

    // Save the button as a block for other templates.
    await page.locator('[data-block="button"]').click();
    await page.getByRole("button", { name: "Save as block" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Course button");
    await page.getByRole("dialog").getByRole("button", { name: "Save block" }).click();
    await expect(page.getByRole("list", { name: "Saved blocks" })).toContainText("Course button");

    // Raw HTML with a script, an event handler, and a javascript: link.
    await page.getByRole("button", { name: "Add raw html" }).click();
    await page.getByTestId("block-settings").getByLabel("HTML").fill(HOSTILE_HTML);
    await expectNoSeriousViolations(page);
    await screenshot(page, "editor");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    await expect(page).toHaveURL(/\/templates\/1$/);

    // The Worker stored the HTML without the script, the handler, or the javascript: URL.
    const saved = await apiGet(page, "/templates/1");
    expect(saved.html).toContain("Start the course");
    expect(saved.html).toContain('id="marker"');
    expect(saved.html).not.toMatch(/<script|onerror|javascript:/i);
    expect(saved.mergeTags).toEqual(["first_name", "unsubscribe_url", "preferences_url"]);

    // The unsaved-draft preview gets the raw HTML as written. The sandbox keeps it inert.
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByTestId("preview-subject")).toHaveText("Welcome, Ada");
    await expect(preview(page).getByRole("heading", { name: "Hello Ada" })).toBeVisible();
    await expectInertPreview(page);

    await page.getByRole("button", { name: "Mobile" }).click();
    await expect(page.getByTestId("email-preview")).toHaveAttribute("data-mode", "mobile");
    await page.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expect(page.getByTestId("email-preview")).toHaveAttribute("data-mode", "dark");
    await expect(preview(page).locator("body")).toHaveCSS("background-color", "rgb(20, 19, 18)");
    await expectInertPreview(page);
    await screenshot(page, "preview-dark");
    // The preview inherits the app's policy. Its remote image and styles are allowed. The
    // policy also blocks the hostile javascript: link that expectInertPreview clicks.
    checkCsp(/^Running the JavaScript URL violates/);
  });

  test("inserts the saved block into a second template, and it renders the same", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/templates");
    await expect(page.getByTestId("saved-block-row")).toContainText("Course button");
    await page.getByRole("button", { name: "New template" }).click();
    await page.getByLabel("Template name").fill("Week two");
    await page.getByRole("button", { name: "Insert Course button" }).click();
    await expect(page.locator('[data-block="button"]')).toContainText("Start the course");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    await expect(page).toHaveURL(/\/templates\/2$/);

    const button = (html: unknown) => {
      const text = String(html);
      const start = text.lastIndexOf("<a ", text.indexOf('href="https://example.com/start"'));
      return text.slice(start, text.indexOf("</a>", start) + 4);
    };
    const first = await apiGet(page, "/templates/1");
    const second = await apiGet(page, "/templates/2");
    expect(button(first.html)).toContain("Start the course");
    expect(button(second.html)).toBe(button(first.html));

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(preview(page).getByRole("link", { name: "Start the course" })).toBeVisible();
  });

  test("an API HTML template with a script is stored without it and previews inertly", async ({
    page,
  }) => {
    await signIn(page);
    const created = await apiPost(page, "/templates", {
      name: "From an agent",
      subject: "Agent news",
      format: "html",
      source: `<html><body>${HOSTILE_HTML}<p>Hi {{ first_name | default: "there" }}</p></body></html>`,
    });
    expect(created.html).not.toMatch(/<script|onerror|javascript:/i);
    await page.goto(`/templates/${created.id}`);
    await expect(page.getByText("HTML", { exact: true })).toBeVisible();
    await expect(preview(page).getByText("Hi Ada")).toBeVisible();
    await expectInertPreview(page);
    await expectNoSeriousViolations(page);
  });

  test("sends a test from the editor that matches the preview", async ({ page, request }) => {
    await signIn(page);
    await apiPost(page, "/connections", {
      provider: "resend",
      credentials: { apiKey: "re_e2e_key_123456" },
    });
    await apiPost(page, "/domains", { domain: "mail.example.com" });

    await page.goto("/templates/1");
    await page.getByRole("button", { name: "Send test" }).click();
    const dialog = page.getByRole("dialog", { name: "Send a test" });
    await expect(dialog.getByLabel(OWNER.email)).toBeChecked();
    await expect(dialog.getByLabel("From address")).toHaveValue("hello@mail.example.com");
    await dialog.getByRole("button", { name: "Send test" }).click();
    await expect(dialog.getByRole("status")).toContainText("Sent");

    const sent = (await (await request.get(`${MOCK}/sent`)).json()) as {
      subject: string;
      html: string;
      to: string[];
    }[];
    const email = sent.find((item) => item.subject === "[Test] Welcome, Ada");
    expect(email?.to).toEqual([OWNER.email]);
    const previewHtml = await apiGet(page, "/templates/1/preview");
    expect(email?.html).toBe(previewHtml.html);
    expect(email?.html).toContain("Start the course");
    expect(email?.html).not.toMatch(/<script|onerror/i);
  });
  test("a failed row action shows an error toast with Try again", async ({ page }) => {
    await signIn(page);
    await page.goto("/templates");
    const duplicate = "**/api/templates/*/duplicate";
    await page.route(duplicate, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "The server failed." } }),
      }),
    );
    await page.getByRole("button", { name: "Duplicate Welcome email" }).first().click();
    const error = page.locator('[data-testid="toast"][data-tone="danger"]');
    await expect(error).toContainText('"Welcome email" was not duplicated. The server failed.');
    // The same failure again replaces the toast instead of stacking a second one.
    await page.getByRole("button", { name: "Duplicate Welcome email" }).first().click();
    await expect(error).toHaveCount(1);
    await expectNoSeriousViolations(page);
    await screenshot(page, "toast-error");

    await page.unroute(duplicate);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByTestId("toast").filter({ hasText: "Template duplicated as" }),
    ).toBeVisible();
  });

  test("asks before it leaves a template with unsaved changes", async ({ page }) => {
    await signIn(page);
    await page.goto("/templates/1");
    await page.getByLabel("Subject").fill("Welcome back, {{ first_name }}");
    await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");

    // An in-app link opens the app dialog. Focus starts on the safe choice.
    await page.getByRole("link", { name: "Templates" }).first().click();
    const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await expectNoSeriousViolations(page);
    await screenshot(page, "unsaved-changes");

    // Escape keeps the page and the changes.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/templates\/1$/);
    await expect(page.getByLabel("Subject")).toHaveValue("Welcome back, {{ first_name }}");

    // Leave without saving: the page changes and the template keeps the saved subject.
    await page.getByRole("link", { name: "Templates" }).first().click();
    await dialog.getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/templates$/);
    const saved = await apiGet(page, "/templates/1");
    expect(saved.subject).toBe("Welcome, {{ first_name }}");

    // After a save, the page changes without a question.
    await page.goto("/templates/1");
    await page.getByLabel("Subject").fill("Welcome, {{ first_name }}!");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    await page.getByRole("link", { name: "Templates" }).first().click();
    await expect(page).toHaveURL(/\/templates$/);
  });
});
