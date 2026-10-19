import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { PROVIDER_MOCK_PORT, PROVIDERS_PORT } from "../playwright.config";

// Provider connections, webhooks, sending domains, and test sends (plan U7), against
// their own fresh Worker. That Worker sends every provider and DNS request to the local
// mock in e2e/provider-mock.mjs, so the tests connect real adapters to fake providers.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${PROVIDERS_PORT}`;
const MOCK = `http://127.0.0.1:${PROVIDER_MOCK_PORT}`;
/** The signing secret that the mock Resend returns when Envelopen creates the webhook. */
const RESEND_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

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

/** A Svix-signed Resend webhook, as Resend sends it. */
function svixHeaders(id: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_SECRET.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

test.describe("providers", () => {
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

  test("connects Resend with one field and creates the webhook", async ({ page, request }) => {
    await signIn(page);
    const step = page.getByTestId("onboarding-step-connect_provider");
    await expect(step).toHaveAttribute("data-status", "todo");
    await step.getByRole("link", { name: "Connect a provider", exact: true }).click();

    await expect(page.getByText("No provider connected")).toBeVisible();
    await expect(page.getByTestId("provider-card")).toHaveCount(5);
    await page.getByRole("button", { name: "Connect Resend" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("API key").fill("re_e2e_key_123456");
    await dialog.getByRole("button", { name: "Connect" }).click();

    const card = page.locator('[data-testid="connection-card"][data-provider="resend"]');
    await expect(card).toContainText("Connected");
    await expect(card).toContainText("Sends your email");
    await expect(card).toContainText("Envelopen created the webhook");
    await expectNoSeriousViolations(page);

    // A signed event from "Resend" reaches the hook and is stored once.
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "e2e-1",
        to: ["student@example.org"],
        bounce: { type: "Permanent", subType: "General" },
      },
    });
    const hook = `${BASE}/hooks/resend/1/1`;
    const first = await request.post(hook, { headers: svixHeaders("msg_e2e_1", body), data: body });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ received: 1, stored: 1 });
    const replay = await request.post(hook, {
      headers: svixHeaders("msg_e2e_1", body),
      data: body,
    });
    expect(await replay.json()).toEqual({ received: 1, stored: 0 });
    const forged = await request.post(hook, {
      headers: svixHeaders("msg_e2e_2", body),
      data: body.replace("student", "someone"),
    });
    expect(forged.status()).toBe(401);
  });

  test("connects toSend with manual steps and the transactional-only warning", async ({ page }) => {
    await signIn(page);
    await page.goto("/connections");
    await page.getByRole("button", { name: "Connect toSend" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Transactional-only provider");
    await dialog.getByLabel("API key").fill("tsend_e2e_key_123");
    await dialog.getByRole("button", { name: "Connect" }).click();

    // A sending key cannot create the webhook, so the manual steps open.
    const webhook = page.getByRole("dialog", { name: "toSend events" });
    await expect(webhook.getByTestId("webhook-url")).toHaveText(`${BASE}/hooks/tosend/1/2`);
    await expect(webhook.getByTestId("webhook-secret")).toHaveText(/^[A-Za-z0-9_-]{40,}$/);
    await expect(webhook.getByTestId("webhook-steps")).toContainText("Bounced and Complaint");
    await expectNoSeriousViolations(page);
    await webhook.getByRole("button", { name: "Done" }).click();

    const card = page.locator('[data-testid="connection-card"][data-provider="tosend"]');
    await expect(card.getByTestId("policy-warning")).toContainText("Campaigns are blocked");
    await expect(card).not.toContainText("Sends your email");
    await card.getByRole("button", { name: "Review the warning" }).click();
    const policy = page.getByRole("dialog");
    const accept = policy.getByRole("button", { name: "Accept the warning" });
    await expect(accept).toBeDisabled();
    await policy.getByRole("checkbox").click();
    await accept.click();
    await expect(card).toContainText("You accepted the transactional-only warning");
    await expect(card.getByTestId("policy-warning")).toHaveCount(0);
  });

  test("adds a sending domain and shows the records and their status", async ({ page }) => {
    await signIn(page);
    const step = page.getByTestId("onboarding-step-verify_domain");
    await expect(step).toHaveAttribute("data-status", "todo");
    await step.getByRole("link", { name: "Add a domain", exact: true }).click();

    await expect(page.getByText("No sending domain yet")).toBeVisible();
    await page.getByRole("textbox", { name: "Sending domain" }).fill("mail.example.com");
    await page.getByRole("button", { name: "Add domain" }).click();

    await expect(page.getByRole("heading", { name: "mail.example.com" })).toBeVisible();
    await expect(page.getByTestId("check-spf")).toHaveAttribute("data-status", "pass");
    await expect(page.getByTestId("check-dkim")).toHaveAttribute("data-status", "pass");
    await expect(page.getByTestId("check-dmarc")).toHaveAttribute("data-status", "missing");
    await expect(page.getByText("Waiting for DNS")).toBeVisible();
    const records = page.getByTestId("dns-record");
    await expect(records).toHaveCount(4);
    await expect(records.filter({ hasText: "DMARC" })).toContainText("v=DMARC1; p=none");
    await expect(records.filter({ hasText: "DKIM" })).toContainText(
      "resend._domainkey.mail.example.com",
    );
    await expectNoSeriousViolations(page);
    await screenshot(page, "domain-dns-page");

    await page.goto("/");
    await expect(page.getByTestId("onboarding-step-verify_domain")).toHaveAttribute(
      "data-status",
      "waiting",
    );
    await expect(page.getByTestId("onboarding-step-connect_provider")).toHaveAttribute(
      "data-status",
      "done",
    );
  });

  test("sends a test email to the owner with both unsubscribe headers", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto("/connections#test-send");
    const section = page.locator("#test-send");
    await expect(section.getByRole("checkbox", { name: OWNER.email })).toBeChecked();
    await expect(section.getByLabel("From address")).toHaveValue("hello@mail.example.com");
    await section.getByRole("button", { name: "Send to 1 address" }).click();
    await expect(section.getByTestId("test-results")).toContainText("Sent");
    await expectNoSeriousViolations(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot(page, "connections-page");

    const sent = (await (await request.get(`${MOCK}/sent`)).json()) as {
      to: string[];
      subject: string;
      headers: Record<string, string>;
    }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([OWNER.email]);
    expect(sent[0]?.headers).toEqual({
      "List-Unsubscribe": `<https://localhost:${PROVIDERS_PORT}/u/test>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });

    await page.goto("/");
    await expect(page.getByTestId("onboarding-step-send_test")).toHaveAttribute(
      "data-status",
      "done",
    );
  });
});
