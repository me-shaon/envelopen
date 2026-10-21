import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { PASSKEY_PORT } from "../playwright.config";
import { watchCsp } from "./csp";

// The admin shell (plan U5). Each describe block runs against its own fresh Worker
// from playwright.config.ts, and its tests run in order on one owner.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WRANGLER = fileURLToPath(
  new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;

/** Runs SQL on the local D1 database of a test Worker. */
function seed(stateName: string, sql: string) {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER,
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      `.wrangler/e2e/${stateName}`,
      "--command",
      sql,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, CI: "1" }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`D1 seed failed: ${result.stderr}`);
}

async function expectNoSeriousViolations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.map(
        (node) => `${node.target.join(" ")}: ${node.any[0]?.message ?? node.failureSummary}`,
      ),
    }));
  expect(serious).toEqual([]);
}

async function screenshot(page: Page, name: string) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

/** Stores the theme and reloads, as a returning visitor would see it. */
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("envelopen.theme", value), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);
  await page.waitForLoadState("networkidle");
}

async function runSetup(page: Page, owner: { email: string; password?: string }) {
  await page.goto("/setup");
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByRole("button", { name: "Check the deployment" }).click();
  await expect(page.getByRole("heading", { name: "Check the deployment" })).toBeVisible();
  await expect(page.getByText("9 of 9 pass")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "CPU time per request" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(owner.email);
  if (owner.password) await page.getByLabel("Password").fill(owner.password);
  await page.getByLabel("First workspace").fill("Course Academy");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function switchWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: /Switch workspace/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
  await expect(page.getByTestId("current-workspace")).toHaveText(name);
}

test.describe("password mode", () => {
  test.describe.configure({ mode: "serial" });

  test("a logged-out visit redirects to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("the admin app sends its security headers", async ({ page }) => {
    for (const path of ["/login", "/campaigns/1", "/theme.js"]) {
      const response = await page.goto(path);
      const headers = response?.headers() ?? {};
      expect(headers["content-security-policy"], path).toContain("default-src 'self'");
      expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["referrer-policy"], path).toBe("same-origin");
    }
    const health = await page.request.get("/api/health");
    expect(health.headers()["cache-control"]).toBe("no-store");
  });

  test("the login page has no serious accessibility violations", async ({ page }) => {
    const checkCsp = watchCsp(page);
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "login-light");
    await setTheme(page, "dark");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await screenshot(page, "login-dark");
    checkCsp();
  });

  test("first-run setup creates the owner, then the owner signs in", async ({ page }) => {
    const checkCsp = watchCsp(page);
    await runSetup(page, OWNER);
    await page.getByRole("button", { name: "Create the owner" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /^Good (morning|afternoon|evening)$/,
    );
    await expect(page.getByTestId("current-workspace")).toHaveText("Course Academy");

    // Setup closes once the owner exists.
    const closed = await page.evaluate(async (token) => {
      const response = await fetch("/api/setup/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      return response.status;
    }, SETUP_TOKEN);
    expect(closed).toBe(404);

    await signOut(page);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
    checkCsp();
  });

  test("the shell has no serious accessibility violations", async ({ page }) => {
    await signIn(page);
    const overviewReady = page.getByTestId("onboarding-step-send_test");
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await expect(overviewReady).toBeVisible();
      await expectNoSeriousViolations(page);
      await screenshot(page, `overview-${theme}`);
    }

    await page.getByRole("link", { name: "Settings" }).first().click();
    const settingsReady = page.getByText("No API keys in this workspace");
    // The footer shows the version from the root package.json.
    await expect(page.getByText(/^Envelopen \d+\.\d+\.\d+/)).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(settingsReady).toBeVisible();
      await expectNoSeriousViolations(page);
      await screenshot(page, `settings-${theme}`);
    }

    await page.getByRole("link", { name: "Contacts" }).click();
    await expect(page.getByText("No contacts yet")).toBeVisible();
    await expectNoSeriousViolations(page);

    // The open switcher menu. Radix hides the page behind a modal menu from screen
    // readers and keeps focus in the menu, so the check covers the menu itself.
    await page.getByRole("button", { name: /Switch workspace/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expectNoSeriousViolations(page, "[role=menu]");
    await page.keyboard.press("Escape");
  });

  test("the owner sets the source link, and the footers show it (AGPL section 13)", async ({
    page,
  }) => {
    const upstream = "https://github.com/me-shaon/envelopen";
    const custom = "https://git.example.com/acme/envelopen";
    await signIn(page);
    const footerLink = page.getByTestId("source-link");
    await expect(footerLink).toHaveAttribute("href", upstream);

    // The public pages show the default link and the version.
    const publicLink = (path: string) =>
      page.request.get(path).then(async (response) => {
        const html = await response.text();
        expect(html).toMatch(/Sent with Envelopen \d+\.\d+\.\d+/);
        return /<a href="([^"]*)"[^>]*>\s*Source code/.exec(html)?.[1];
      });
    expect(await publicLink("/u/test")).toBe(upstream);

    await page.goto("/settings");
    const field = page.getByLabel("Source code URL");
    await expect(field).toHaveValue(upstream);
    const save = page.getByRole("button", { name: "Save source link" });
    for (const bad of ["javascript:alert(1)", "http://git.example.com/acme/envelopen"]) {
      await field.fill(bad);
      await field.blur();
      await expect(page.getByText("Enter a full URL that starts with https://.")).toBeVisible();
      await expect(save).toBeDisabled();
    }

    await field.fill(custom);
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(footerLink).toHaveAttribute("href", custom);

    // The setting survives a reload, and the public pages show it too.
    await page.reload();
    await expect(field).toHaveValue(custom);
    await expect(footerLink).toHaveAttribute("href", custom);
    expect(await publicLink("/u/test")).toBe(custom);
    expect(await publicLink("/t/invalid")).toBe(custom);

    // Back to the upstream link.
    await page.getByRole("button", { name: "Use the default" }).click();
    await save.click();
    await expect(footerLink).toHaveAttribute("href", upstream);
  });

  test("the owner sets the Workers plan, and the usage view marks it and its threshold (KTD9)", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/usage");
    // The default plan is Free: the view shows the reserved threshold of welcome emails.
    await expect(page.getByTestId("usage-reserved")).toContainText(
      "Welcome emails wait from 70,000 writes (70%).",
    );
    await expect(page.getByTestId("usage-reserved-line")).toHaveCount(1);
    await expect(page.getByTestId("usage-automation")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Free (your plan)" })).toBeVisible();

    await page.goto("/settings#workers-plan");
    const section = page.locator("#workers-plan");
    await expect(section.getByRole("radio", { name: /Workers Free/ })).toBeChecked();
    await section.getByRole("radio", { name: /Workers Paid/ }).check();
    await section.getByRole("button", { name: "Save plan" }).click();
    await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

    await page.goto("/usage");
    await expect(page.getByRole("columnheader", { name: "Paid (your plan)" })).toBeVisible();
    await expect(page.getByTestId("usage-reserved")).toHaveCount(0);
    await expect(page.getByTestId("usage-reserved-line")).toHaveCount(0);

    // Back to Free. The setting survives a reload.
    await page.goto("/settings#workers-plan");
    await expect(section.getByRole("radio", { name: /Workers Paid/ })).toBeChecked();
    await section.getByRole("radio", { name: /Workers Free/ }).check();
    await section.getByRole("button", { name: "Save plan" }).click();
    await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await page.reload();
    await expect(section.getByRole("radio", { name: /Workers Free/ })).toBeChecked();
  });

  test("the workspace switcher changes the data that a list view loads", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    await page.getByLabel("New workspace").fill("Second School");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByTestId("workspace-row")).toHaveCount(2);

    // A key in the second workspace.
    await switchWorkspace(page, "Second School");
    await expect(page.getByText("No API keys in this workspace")).toBeVisible();
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill("Enrollment sync");
    await page.getByRole("radio", { name: /Enrollment sync/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
    await expect(page.getByTestId("new-api-key")).toHaveValue(/^evk_/);
    // An enrollment sync key is not for agents, so the dialog shows no MCP config.
    await expect(page.getByTestId("mcp-client-config")).toHaveCount(0);
    await screenshot(page, "api-key-created-light");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("api-key-row")).toHaveCount(1);

    // The first workspace has no keys. The list follows the switcher.
    await switchWorkspace(page, "Course Academy");
    await expect(page.getByText("No API keys in this workspace")).toBeVisible();
    await expect(page.getByTestId("api-key-row")).toHaveCount(0);

    await switchWorkspace(page, "Second School");
    await expect(page.getByTestId("api-key-row")).toHaveCount(1);
    await expect(page.getByTestId("api-key-row")).toContainText("Enrollment sync");

    // The choice survives a reload.
    await page.reload();
    await expect(page.getByTestId("current-workspace")).toHaveText("Second School");

    // Revoke the key.
    await page.getByRole("button", { name: "Revoke Enrollment sync" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByTestId("api-key-row")).toContainText("Revoked");

    // An agent key comes with the MCP endpoint and a client config that holds the key.
    await expect(page.getByTestId("mcp-endpoint")).toHaveText(/\/mcp$/);
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill("Agent");
    await page.getByRole("radio", { name: /Agent editor/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
    const newKey = await page.getByTestId("new-api-key").inputValue();
    await expect(page.getByTestId("mcp-client-config")).toContainText(`Bearer ${newKey}`);
    await expect(page.getByTestId("mcp-client-config")).toContainText("/mcp");
    await expectNoSeriousViolations(page, "[role=dialog]");
    await screenshot(page, "api-key-agent-config-light");
    await page.getByRole("button", { name: "Done" }).click();

    // Archive the current workspace. The shell moves to the remaining one.
    await page.getByRole("button", { name: "Archive Second School" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await expect(page.getByTestId("current-workspace")).toHaveText("Course Academy");
  });

  test("the onboarding checklist marks a step done when its condition holds", async ({ page }) => {
    await signIn(page);
    const step = page.getByTestId("onboarding-step-import_contacts");
    await expect(step).toHaveAttribute("data-status", "todo");
    await expect(page.getByTestId("onboarding-step-verify_domain")).toHaveAttribute(
      "data-status",
      "blocked",
    );
    await expect(page.getByTestId("onboarding-progress")).toHaveText("0 of 4 done");

    const workspaceId = await page.evaluate(async () => {
      const response = await fetch("/api/workspace");
      return ((await response.json()) as { id: number }).id;
    });
    seed(
      "password",
      "INSERT INTO contacts (workspace_id, email, consent_basis, consent_source, consent_at, source) " +
        `VALUES (${Number(workspaceId)}, 'student@example.com', 'explicit_opt_in', 'e2e', 0, 'ui')`,
    );

    await page.reload();
    await expect(step).toHaveAttribute("data-status", "done");
    await expect(step).toContainText("Done");
    await expect(page.getByTestId("onboarding-progress")).toHaveText("1 of 4 done");
  });
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
}

test.describe("passkey mode", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://localhost:${PASSKEY_PORT}` });

  test("setup registers a passkey, and the owner signs in with it", async ({ page }) => {
    // Chromium's virtual authenticator answers the WebAuthn prompts.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await runSetup(page, { email: "passkey-owner@example.com" });
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await page.getByRole("button", { name: "Create and add a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();

    // The new passkey is a discoverable credential on the authenticator.
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.isResidentCredential).toBe(true);

    await signOut(page);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
    await expect(page.getByTestId("current-workspace")).toHaveText("Course Academy");
  });
});
