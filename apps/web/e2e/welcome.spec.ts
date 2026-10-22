import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { WELCOME_MOCK_PORT, WELCOME_PORT } from "../playwright.config";
import { watchCsp } from "./csp";

// Welcome series (plan U10, F2), against a fresh Worker. The steps send through the local
// provider mock (OUTBOUND_MOCK_ORIGIN), so nothing leaves the machine. The editor test
// builds a series with the welcome template. The run test starts the series for a contact
// through the API and checks one email per step in the mock.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const BASE = `http://localhost:${WELCOME_PORT}`;
const MOCK = `http://127.0.0.1:${WELCOME_MOCK_PORT}`;

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

async function api(page: Page, method: "POST" | "PUT" | "GET", path: string, data?: unknown) {
  const res = await page.request.fetch(`${BASE}/api${path}`, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: { Origin: BASE },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

interface SentEmail {
  to: string | string[];
  subject: string;
  html: string;
  headers?: Record<string, string>;
}

async function sentTo(page: Page, email: string): Promise<SentEmail[]> {
  const sent = (await (await page.request.get(`${MOCK}/sent`)).json()) as SentEmail[];
  return sent.filter((item) => [item.to].flat().includes(email));
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }));
  expect(serious).toEqual([]);
}

test.describe("welcome series", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, viewport: { width: 1360, height: 1000 } });

  let seriesId = 0;
  let listId = 0;

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

  test("the owner builds a series with the welcome template, waits between emails, and turns it on", async ({
    page,
  }) => {
    const checkCsp = watchCsp(page);
    await signIn(page);
    await api(page, "POST", "/connections", {
      provider: "resend",
      credentials: { apiKey: "re_e2e_key_123456" },
    });
    const domain = await api(page, "POST", "/domains", { domain: "mail.example.com" });
    expect(domain.status).toBe("verified");
    const list = await api(page, "POST", "/lists", { name: "Course news" });
    listId = list.id as number;
    // A second list with its own series. One contact is on both lists.
    const alumni = await api(page, "POST", "/lists", { name: "Alumni" });
    const template = await api(page, "POST", "/templates", {
      name: "Alumni hello",
      subject: "Hello again",
      format: "markdown",
      source: "Hello again.\n\n[Unsubscribe]({{ unsubscribe_url }})",
    });
    await api(page, "POST", "/welcome-series", {
      listId: alumni.id,
      name: "Alumni welcome",
      steps: [{ templateId: template.id, subject: "Hello again", delayMinutes: 0 }],
    });
    await api(page, "POST", "/contacts", {
      email: "both@example.org",
      consentBasis: "explicit_opt_in",
      listIds: [listId, alumni.id],
    });

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Welcome series" })
      .click();
    await expect(page.getByRole("heading", { name: "Welcome series", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "New series" }).click();
    await expect(page.getByRole("heading", { name: "New welcome series" })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Course welcome");
    await page.getByLabel("List", { exact: true }).selectOption({ label: "Course news" });
    // The note next to the list picker: the shared contact gets both series.
    await expect(page.getByTestId("welcome-overlap")).toContainText(
      '1 contact of this list is also on "Alumni"',
    );

    // The empty state offers the gallery's welcome template for email 1 (U15).
    await page.getByRole("button", { name: "Use the welcome template" }).click();
    const steps = page.getByTestId("welcome-step");
    await expect(steps.nth(0).getByLabel("Template")).toHaveValue(/\d+/);
    await expect(steps.nth(0).getByLabel("Subject")).toHaveValue(/Welcome/);

    // Email 2, two days after email 1.
    await page.getByRole("button", { name: "Add email" }).click();
    await expect(steps).toHaveCount(2);
    const delays = page.getByTestId("welcome-delay");
    await delays.nth(1).getByRole("spinbutton").fill("2");
    await delays.nth(1).getByRole("combobox").selectOption("days");
    await steps.nth(1).getByLabel("Subject").fill("Your first lesson");
    await steps.nth(1).getByLabel("Template").selectOption({ label: "Welcome email" });

    // The template preview shows the step's subject.
    await page.getByRole("button", { name: "Preview email 2" }).click();
    const preview = page.getByRole("dialog", { name: "Template preview" });
    await expect(preview.getByTestId("preview-subject")).toHaveText("Your first lesson");
    await preview.getByRole("button", { name: "Close" }).first().click();

    await expectNoSeriousViolations(page);
    await page.getByRole("button", { name: "Create series" }).click();
    await expect(page.getByRole("heading", { name: "Course welcome" })).toBeVisible();
    seriesId = Number(/\/welcome\/(\d+)/.exec(page.url())?.[1]);
    expect(seriesId).toBeGreaterThan(0);

    // A test send of email 2 goes to the owner with the step's subject.
    await page.getByRole("button", { name: "Send test of email 2" }).click();
    const dialog = page.getByRole("dialog", { name: "Send a test" });
    await dialog.getByRole("button", { name: "Send test" }).click();
    await expect(dialog.getByRole("status")).toContainText("Sent");
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect
      .poll(async () => (await sentTo(page, OWNER.email)).map((m) => m.subject))
      .toEqual(["[Test] Your first lesson"]);

    const toggle = page.getByRole("switch", { name: "Series is off" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(page.getByRole("switch", { name: "Series is on" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("welcome-entered")).toHaveText("0 contacts entered");

    // The lists page links each list to its series.
    await page.goto("/contacts/lists");
    await expect(
      page.getByRole("link", { name: "On welcome series of Course news" }),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
    checkCsp();
  });

  test("a contact added with the start option gets each email once, with working unsubscribe headers", async ({
    page,
  }) => {
    await signIn(page);
    const series = await api(page, "GET", `/welcome-series/${seriesId}`);
    const steps = series.steps as { templateId: number; subject: string; delayMinutes: number }[];
    // Shorter waits, so the run ends within the test.
    await api(page, "PUT", `/welcome-series/${seriesId}`, {
      name: series.name,
      steps: steps.map((step) => ({ ...step, delayMinutes: 0 })),
    });

    // Without the start option, nothing starts.
    const plain = await api(page, "POST", "/contacts", {
      email: "plain@example.org",
      consentBasis: "explicit_opt_in",
      listIds: [listId],
    });
    expect(plain.welcomeStarted).toBe(0);
    const started = await api(page, "POST", "/contacts", {
      email: "new.student@example.org",
      firstName: "Nia",
      consentBasis: "explicit_opt_in",
      listIds: [listId],
      startWelcome: true,
    });
    expect(started.welcomeStarted).toBe(1);

    await expect
      .poll(async () => (await sentTo(page, "new.student@example.org")).map((m) => m.subject), {
        timeout: 30_000,
      })
      .toEqual(["Welcome, Nia", "Your first lesson"]);
    const [first] = await sentTo(page, "new.student@example.org");
    expect((first?.html ?? "").replace(/<[^>]+>/g, "")).toContain("Hi Nia,");
    expect(first?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const unsubscribe = /<([^>]+)>/.exec(first?.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(unsubscribe).toMatch(/\/u\//);
    // A second add starts nothing, and the plain contact got nothing.
    const again = await api(page, "POST", `/lists/${listId}/contacts`, {
      contactIds: [(started.contact as { id: number }).id],
      startWelcome: true,
    });
    expect(again.welcomeStarted).toBe(0);
    expect(await sentTo(page, "plain@example.org")).toEqual([]);

    // The one-click link of the welcome email unsubscribes the contact.
    const path = new URL(unsubscribe).pathname;
    const res = await page.request.post(`${BASE}${path}`, {
      form: { "List-Unsubscribe": "One-Click" },
    });
    expect(res.status()).toBe(200);
    const contact = await api(page, "GET", `/contacts/${(started.contact as { id: number }).id}`);
    expect(contact.status).toBe("unsubscribed");

    await page.goto(`/welcome/${seriesId}`);
    await expect(page.getByTestId("welcome-entered")).toHaveText("1 contact entered");
    await expect(page.getByTestId("welcome-step-stats").first()).toHaveText("1 sent");
    // Each step went out once.
    expect((await sentTo(page, "new.student@example.org")).length).toBe(2);
  });
});
