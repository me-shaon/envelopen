import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { BRAND_MOCK_PORT, BRAND_PORT } from "../playwright.config";
import { watchCsp } from "./csp";

// The brand kit (plan U13, R18, R19, AE5), against its own fresh Worker. The Worker sends
// provider and DNS requests to its own instance of e2e/provider-mock.mjs, which serves
// the DMARC record, so the sending domain verifies. The tests run in order on one owner.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${BRAND_PORT}`;
const MOCK = `http://127.0.0.1:${BRAND_MOCK_PORT}`;
/** A 1 x 1 PNG image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const BRANDED_HTML =
  '<html><body><img src="{{ brand.logo_url }}" alt="{{ brand.name }}" width="120">' +
  '<p style="color:{{ brand.color_primary }}">{{ brand.name }}</p>' +
  '<p>Hello {{ first_name | default: "there" }}</p>' +
  '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>';

interface SentEmail {
  to: string | string[];
  subject: string;
  html: string;
}

async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // The preview is the email itself. Axe checks the app.
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
  await expect(
    page
      .getByRole("heading", { name: "Finish setting up" })
      .or(page.getByTestId("onboarding-complete")),
  ).toBeVisible();
}

async function api(page: Page, method: "post" | "put", path: string, data: unknown) {
  const res = await page.request[method](`${BASE}/api${path}`, {
    data,
    headers: { Origin: BASE },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function sentEmails(page: Page): Promise<SentEmail[]> {
  return (await (await page.request.get(`${MOCK}/sent`)).json()) as SentEmail[];
}

test.describe("brand kit", () => {
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

  test("confirm is blocked without a postal address, and the fix link opens the brand page", async ({
    page,
  }) => {
    await signIn(page);
    await api(page, "post", "/connections", {
      provider: "resend",
      credentials: { apiKey: "re_e2e_key_123456" },
    });
    const domain = await api(page, "post", "/domains", { domain: "mail.example.com" });
    expect(domain.status).toBe("verified");
    const list = await api(page, "post", "/lists", { name: "Brand testers" });
    await api(page, "post", "/contacts", {
      email: OWNER.email,
      firstName: "Ada",
      consentBasis: "existing_customer",
      listIds: [list.id],
    });
    const template = await api(page, "post", "/templates", {
      name: "Branded news",
      subject: "News from {{ brand.name }}",
      format: "html",
      source: BRANDED_HTML,
    });
    const draft = await api(page, "post", "/campaigns", {
      name: "Brand launch",
      templateId: template.id,
      fromName: "Course Academy",
      fromEmail: "news@mail.example.com",
      audience: { listIds: [list.id], tagIds: [], excludeListIds: [], excludeTagIds: [] },
    });

    await page.goto(`/campaigns/${draft.id}`);
    await page.getByRole("button", { name: "Review and send" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Check and continue" }).click();
    const item = dialog.locator('[data-testid="checklist-item"][data-status="fail"]', {
      hasText: "Postal address",
    });
    await expect(item).toBeVisible();
    await item.getByRole("link", { name: "Add the postal address in Brand" }).click();
    await expect(page).toHaveURL(/\/brand$/);
    await expect(page.getByRole("heading", { name: "Brand", level: 1 })).toBeVisible();
  });

  test("the owner sets the brand with a live preview, uploads a logo, and SVG is refused", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    await signIn(page);
    await page.getByRole("link", { name: "Brand", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Brand", level: 1 })).toBeVisible();
    const preview = page.frameLocator('iframe[title="Email preview"]');
    // The preview shows the workspace name until the brand has its own.
    await expect(preview.getByText("Course Academy").first()).toBeVisible();

    await page.getByLabel("Brand name").fill("Acme Studio");
    await page.getByLabel("Primary color", { exact: true }).fill("#112233");
    await page.getByLabel("Font", { exact: true }).selectOption({ label: "Georgia" });
    await page.getByLabel("Footer text").fill("You get this because you joined Acme.");
    await page.getByLabel("Postal address").fill("1 Course Street, Springfield");
    await page.getByLabel("X", { exact: true }).fill("https://x.com/acme");
    // The preview follows the fields before the save.
    await expect(preview.getByText("Acme Studio").first()).toBeVisible();
    await expect(preview.getByText("1 Course Street, Springfield")).toBeVisible();
    await expect(preview.getByRole("link", { name: "X", exact: true })).toBeVisible();
    await expect(preview.getByText("Acme Studio").first()).toHaveCSS("color", "rgb(17, 34, 51)");
    await page.getByRole("button", { name: "Save brand" }).click();
    await expect(page.getByText("Brand saved.")).toBeVisible();

    // A hostile social link is refused with the field named.
    await page.getByLabel("X", { exact: true }).fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Save brand" }).click();
    await expect(page.getByText("Each social link must be a full https URL")).toBeVisible();
    await page.getByLabel("X", { exact: true }).fill("https://x.com/acme");
    await page.getByRole("button", { name: "Save brand" }).click();
    await expect(page.getByText("Brand saved.").first()).toBeVisible();

    // An SVG, also one named .png, is refused by its bytes.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    await page
      .locator("#brand-logo")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: svg });
    await expect(page.getByRole("alert")).toContainText("SVG is not accepted");
    await expect(page.getByTestId("brand-logo")).toHaveCount(0);

    await page
      .locator("#brand-logo")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("brand-logo")).toBeVisible();
    await expect(page.getByText("Logo saved.")).toBeVisible();
    const src = await page.getByTestId("brand-logo").getAttribute("src");
    expect(src).toMatch(/\/b\/\d+\/[0-9a-f]{64}\.png$/);
    const logo = await page.request.get(src ?? "");
    expect(logo.status()).toBe(200);
    expect(logo.headers()["content-type"]).toBe("image/png");
    expect(logo.headers()["x-content-type-options"]).toBe("nosniff");
    await expect(preview.locator(`img[src="${src}"]`)).toBeVisible();

    await expectNoSeriousViolations(page);
    await screenshot(page, "brand-page");
    checkCsp();
  });

  test("the editor inserts brand blocks and brand colors, and the preview shows the brand", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/templates/new");
    await page.getByLabel("Template name").fill("Brand blocks");
    await page.getByLabel("Subject").fill("News from Acme");
    await page.getByRole("button", { name: "Add brand header" }).click();
    const settings = page.getByTestId("block-settings");
    await expect(settings.getByRole("heading", { name: "Brand header" })).toBeVisible();
    await page.getByRole("button", { name: "Add button" }).click();
    await settings.getByRole("button", { name: "Brand primary" }).first().click();
    await expect(settings.getByRole("button", { name: "Brand primary" }).first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Add brand footer" }).click();
    await expect(settings.getByLabel("X", { exact: true })).toBeChecked();
    await page.getByLabel("Email font").selectOption("brand");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    await expectNoSeriousViolations(page);

    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Email preview"]');
    await expect(preview.getByText("Acme Studio").first()).toBeVisible();
    await expect(preview.getByText("1 Course Street, Springfield")).toBeVisible();
    await expect(preview.getByRole("link", { name: "Read more" })).toHaveCSS(
      "background-color",
      "rgb(17, 34, 51)",
    );
    await expect(preview.locator('img[src*="/b/"]').first()).toBeVisible();
    await screenshot(page, "brand-editor-preview");
  });

  test("covers AE5: the sent email keeps the brand of confirm time, and drafts show the new one", async ({
    page,
  }) => {
    await signIn(page);
    const templates = (await (await page.request.get(`${BASE}/api/templates`)).json()) as {
      items: { id: number; name: string }[];
    };
    const template = templates.items.find((item) => item.name === "Branded news");
    const campaigns = (await (await page.request.get(`${BASE}/api/campaigns`)).json()) as {
      items: { id: number; name: string }[];
    };
    const draft = campaigns.items.find((item) => item.name === "Brand launch");
    expect(template && draft).toBeTruthy();

    const prepared = await api(page, "post", `/campaigns/${draft?.id}/prepare`, {
      mode: "send_now",
    });
    expect(prepared.blocked, JSON.stringify(prepared.checklist)).toBe(false);
    await api(page, "post", `/campaigns/${draft?.id}/confirm`, { token: prepared.token });
    // The owner changes the brand at once.
    await api(page, "put", "/brand", {
      name: "Acme Two",
      colorPrimary: "#445566",
      colorAccent: "#ede9f8",
      font: "georgia",
      footer: "",
      address: "1 Course Street, Springfield",
      social: {},
    });

    let email: SentEmail | undefined;
    await expect(async () => {
      email = (await sentEmails(page)).find((item) => [item.to].flat().includes(OWNER.email));
      expect(email).toBeTruthy();
    }).toPass({ timeout: 30_000 });
    // The snapshot of confirm time fills the tokens, as literal values.
    expect(email?.subject).toBe("News from Acme Studio");
    expect(email?.html).toContain('<p style="color:#112233">Acme Studio</p>');
    expect(email?.html).toMatch(/<img src="https?:\/\/[^"]+\/b\/\d+\/[0-9a-f]{64}\.png"/);
    expect(email?.html).not.toContain("{{ brand.");

    // A new draft shows the new brand.
    const next = await api(page, "post", "/campaigns", {
      name: "Next issue",
      templateId: template?.id,
      fromName: "Course Academy",
      fromEmail: "news@mail.example.com",
    });
    const previewed = (await (
      await page.request.get(`${BASE}/api/campaigns/${next.id}/preview`)
    ).json()) as { html: string; subject: string };
    expect(previewed.subject).toBe("News from Acme Two");
    expect(previewed.html).toContain('<p style="color:#445566">Acme Two</p>');
  });
});
