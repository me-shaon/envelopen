import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { SMTP_MOCK_HTTP_PORT, SMTP_PORT } from "../playwright.config";

// SMTP connections with presets (U18), against their own fresh Worker. That Worker
// sends every SMTP connection to the local SMTP mock in e2e/smtp-mock.mjs, and its DNS
// requests to the provider mock, so no test reaches a real mail server or Brevo.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${SMTP_PORT}`;
const SMTP_MESSAGES = `http://127.0.0.1:${SMTP_MOCK_HTTP_PORT}/messages`;

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

async function openSmtpDialog(page: Page, preset: string) {
  await page.goto("/connections");
  await page.getByRole("button", { name: "Connect SMTP" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: preset }).click();
  return dialog;
}

test.describe("smtp", () => {
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
    await request.delete(SMTP_MESSAGES);
  });

  test("connects a custom SMTP server and sends a test email through it", async ({
    page,
    request,
  }) => {
    await signIn(page);
    const dialog = await openSmtpDialog(page, "Custom SMTP");
    await expect(dialog.getByTestId("preset-fields")).toHaveAttribute("data-preset", "custom");
    await dialog.getByLabel("SMTP host").fill("smtp.example.com");
    await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("587");
    await dialog.getByLabel("User name").fill("mailer@example.com");
    // The mock refuses the password "wrong" with a 535.
    await dialog.getByLabel("Password", { exact: true }).fill("wrong");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await expect(dialog.getByRole("alert")).toContainText("535");
    await dialog.getByLabel("Password", { exact: true }).fill("a-good-password");
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Connect" }).click();

    const card = page.locator('[data-testid="connection-card"][data-provider="smtp"]');
    await expect(card).toContainText("Connected");
    await expect(card).toContainText("Sends your email");
    await expect(card).toContainText("mailer@example.com on smtp.example.com:587");
    await expect(card.getByTestId("connection-warning")).toContainText(
      "no bounce or complaint events",
    );
    await expect(card.getByTestId("policy-warning")).toHaveCount(0);

    await page.goto("/connections/domains");
    await page.getByRole("textbox", { name: "Sending domain" }).fill("mail.example.com");
    await page.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByRole("heading", { name: "mail.example.com" })).toBeVisible();

    await page.goto("/connections#test-send");
    const section = page.locator("#test-send");
    await expect(section.getByRole("checkbox", { name: OWNER.email })).toBeChecked();
    await section.getByRole("button", { name: "Send to 1 address" }).click();
    await expect(section.getByTestId("test-results")).toContainText("Sent");

    const messages = (await (await request.get(SMTP_MESSAGES)).json()) as {
      from: string;
      to: string[];
      data: string;
      secure: boolean;
    }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toEqual([OWNER.email]);
    expect(messages[0]?.secure).toBe(true);
    const headers = (messages[0]?.data ?? "").split("\r\n\r\n")[0] ?? "";
    expect(headers).toContain(`List-Unsubscribe: <https://localhost:${SMTP_PORT}/u/test>`);
    expect(headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  test("warns about Gmail before campaigns and lets the owner accept", async ({ page }) => {
    await signIn(page);
    const dialog = await openSmtpDialog(page, "Gmail");
    await expect(dialog.getByTestId("preset-warning")).toContainText("Gmail sending policy");
    await expect(dialog.getByTestId("preset-warning")).toContainText("Google can lock an account");
    await expect(dialog.getByRole("link", { name: "Create an app password" })).toHaveAttribute(
      "href",
      "https://myaccount.google.com/apppasswords",
    );
    await expect(dialog.getByLabel("Daily sending limit")).toHaveValue("500");
    await expect(dialog.getByLabel("SMTP host")).toHaveCount(0);
    await dialog.getByLabel("Google account address").fill("ada@gmail.com");
    await dialog.getByLabel("App password").fill("abcd efgh ijkl mnop");
    await expectNoSeriousViolations(page);
    await dialog.getByRole("button", { name: "Connect" }).click();

    const card = page.locator('[data-testid="connection-card"]').filter({ hasText: "Gmail" });
    await expect(card).toContainText("Connected");
    await expect(card).toContainText("Daily limit 500");
    await card.getByRole("button", { name: "Use for sending" }).click();
    await expect(card).toContainText("Sends your email");
    await expect(card.getByTestId("policy-warning")).toContainText("Campaigns are blocked");
    await card.getByRole("button", { name: "Review the warning" }).click();
    const policy = page.getByRole("dialog", { name: "Send campaigns through Gmail?" });
    await expect(policy).toContainText("personal Gmail account");
    const accept = policy.getByRole("button", { name: "Accept the warning" });
    await expect(accept).toBeDisabled();
    await policy.getByRole("checkbox").click();
    await accept.click();
    await expect(card).toContainText("You accepted the sending policy warning");
    await expect(card.getByTestId("policy-warning")).toHaveCount(0);
  });

  test("connects Brevo with a bearer token webhook that can rotate", async ({ page, request }) => {
    await signIn(page);
    const dialog = await openSmtpDialog(page, "Brevo");
    await expect(dialog.getByLabel("Daily sending limit")).toHaveValue("300");
    await dialog.getByLabel("SMTP login").fill("ada@example.com");
    await dialog.getByLabel("SMTP key").fill("xsmtpsib-e2e-key");
    await dialog.getByRole("button", { name: "Connect" }).click();

    const webhook = page.getByRole("dialog", { name: "Brevo events" });
    const url = await webhook.getByTestId("webhook-url").textContent();
    expect(url).toMatch(new RegExp(`^${BASE}/hooks/smtp/1/\\d+$`));
    const token = (await webhook.getByTestId("webhook-secret").textContent()) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await expect(webhook.getByTestId("webhook-steps")).toContainText('"type":"bearer"');
    await expectNoSeriousViolations(page);

    const event = JSON.stringify({
      event: "hard_bounce",
      email: "gone@example.org",
      "message-id": "<e2e@mail.example.com>",
      ts_epoch: Date.now(),
    });
    const post = (bearer: string) =>
      request.post(url ?? "", {
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        data: event,
      });
    const ok = await post(token);
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ received: 1, stored: 1 });
    expect((await post("not-the-token")).status()).toBe(401);

    await webhook.getByRole("button", { name: "Rotate the token" }).click();
    await expect(webhook.getByRole("status")).toContainText("The old token no longer works");
    await expect(webhook.getByTestId("webhook-secret")).not.toHaveText(token);
    expect((await post(token)).status()).toBe(401);
    const fresh = (await webhook.getByTestId("webhook-secret").textContent()) ?? "";
    expect((await post(fresh)).status()).toBe(200);
  });
});
