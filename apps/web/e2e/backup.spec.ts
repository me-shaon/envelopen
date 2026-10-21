import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { BACKUP_SOURCE_PORT, BACKUP_TARGET_PORT } from "../playwright.config";

// Backups and restore (plan U4, U5, R1 to R4, AE7), against two fresh Workers: the
// source backs up, warns when its S3 copy fails, and gives a download. The target is
// a new deployment with other keys. Its first-run screen restores the downloaded file.

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "";
const OWNER = { name: "Ada Owner", email: "owner@example.com", password: "correct horse battery" };
const PASSPHRASE = "a long and private backup passphrase";
const SOURCE = `http://localhost:${BACKUP_SOURCE_PORT}`;
const TARGET = `http://localhost:${BACKUP_TARGET_PORT}`;
const CONTACTS = ["ana@example.com", "ben@example.com", "chen@example.com"];
const SUPPRESSED = "left@example.com";

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }));
  expect(serious).toEqual([]);
}

async function signIn(page: Page, base: string) {
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** A same-origin API call with the session cookie, as the app makes it. */
async function apiPost(page: Page, base: string, path: string, data: unknown) {
  const res = await page.request.post(`${base}/api${path}`, { data, headers: { Origin: base } });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function apiGet(page: Page, base: string, path: string) {
  const res = await page.request.get(`${base}/api${path}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** Clicks "Back up now" and waits for the new run to end with `status`. */
async function backUpNow(page: Page, status: "Succeeded" | "Partial") {
  const section = page.locator("#backups");
  await section.getByRole("button", { name: "Back up now" }).click();
  const table = section.getByRole("table", { name: "Backups" });
  await expect(table.locator("tbody tr").first().getByText(status, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("backups", () => {
  test.describe.configure({ mode: "serial" });
  let archivePath = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${SOURCE}/api/setup/owner`, {
      data: {
        token: SETUP_TOKEN,
        email: OWNER.email,
        name: OWNER.name,
        workspaceName: "Course Academy",
        password: OWNER.password,
      },
      headers: { Origin: SOURCE },
    });
    expect(res.status()).toBe(201);
  });

  test("sets the passphrase, warns about a failed S3 copy, and downloads a backup", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page, SOURCE);
    const list = await apiPost(page, SOURCE, "/lists", { name: "Students" });
    for (const email of CONTACTS) {
      await apiPost(page, SOURCE, "/contacts", {
        email,
        consentBasis: "explicit_opt_in",
        listIds: [list.id],
      });
    }
    await apiPost(page, SOURCE, "/suppressions", { emails: [SUPPRESSED] });

    await page.goto(`${SOURCE}/settings#backups`);
    const section = page.locator("#backups");
    await expect(section.getByRole("heading", { name: "Backups", level: 2 })).toBeVisible();
    await expect(section.getByText("nobody can recover a lost passphrase")).toBeVisible();
    await expect(section.getByRole("button", { name: "Back up now" })).toBeDisabled();

    // The passphrase: too short first, then the real one.
    await section.getByLabel("Passphrase", { exact: true }).fill("too short");
    await section.getByLabel("Repeat the passphrase").fill("too short");
    await section.getByRole("button", { name: "Set the passphrase" }).click();
    await expect(section.getByText("Use at least 12 characters.")).toBeVisible();
    await section.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await section.getByLabel("Repeat the passphrase").fill(PASSPHRASE);
    await section.getByRole("button", { name: "Set the passphrase" }).click();
    await expect(section.getByText(/^Set on /)).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousViolations(page);

    // An S3 copy that fails: the mock has no S3, so the run is partial (AE7).
    await section.getByRole("button", { name: "Add a destination" }).click();
    await section.getByLabel("Endpoint").fill("https://s3.example.test");
    await section.getByLabel("Region").fill("us-east-1");
    await section.getByLabel("Bucket").fill("envelopen-backups");
    await section.getByLabel("Access key id").fill("AKIDEXAMPLE");
    await section.getByLabel("Secret access key").fill("not-a-real-secret");
    await section.getByRole("button", { name: "Save the destination" }).click();
    await expect(section.getByText("envelopen-backups at s3.example.test")).toBeVisible();
    await backUpNow(page, "Partial");

    // The warning shows on every page, with the time of the last successful backup.
    await page.goto(`${SOURCE}/contacts`);
    const banner = page.getByTestId("backup-banner");
    await expect(banner).toContainText("its S3 copy failed");
    await expect(banner).toContainText("The last successful backup was on");
    await banner.getByRole("link", { name: "Open the backup settings" }).click();

    // Without the S3 copy, the next run succeeds, and the warning goes away.
    await section.getByRole("button", { name: "Remove" }).click();
    await expect(section.getByText("Optional")).toBeVisible();
    await backUpNow(page, "Succeeded");
    await page.goto(`${SOURCE}/contacts`);
    await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
    await expect(page.getByTestId("backup-banner")).toHaveCount(0);

    // The download: one .envbak file.
    await page.goto(`${SOURCE}/settings#backups`);
    const downloadPromise = page.waitForEvent("download");
    await section
      .getByRole("button", { name: /^Download the backup of/ })
      .first()
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^envelopen-backup-.*\.envbak$/);
    archivePath = test.info().outputPath("backup.envbak");
    await download.saveAs(archivePath);
    expect(readFileSync(archivePath).subarray(0, 8).toString()).toBe("ENVBAK01");
  });

  test("restores the file on the first-run screen of a new deployment", async ({ page }) => {
    test.setTimeout(120_000);
    expect(archivePath).not.toBe("");
    await page.goto(`${TARGET}/setup`);
    await page.getByLabel("Setup token").fill(SETUP_TOKEN);
    await page.getByRole("button", { name: "Check the deployment" }).click();
    await page.getByRole("button", { name: "Restore a backup" }).click();
    await expect(page.getByRole("heading", { name: "Restore a backup" })).toBeVisible();
    await expectNoSeriousViolations(page);

    // A wrong passphrase is refused, and nothing is written.
    await page.getByLabel("Backup file").setInputFiles(archivePath);
    await page.getByLabel("Backup passphrase").fill("this is not the passphrase");
    await page.getByRole("button", { name: "Start the restore" }).click();
    await expect(page.getByRole("heading", { name: "The passphrase is not correct" })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Try again" }).click();

    // The right passphrase.
    await page.getByLabel("Backup file").setInputFiles(archivePath);
    await page.getByLabel("Backup passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Start the restore" }).click();
    await expect(page.getByRole("heading", { name: "Restore complete" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("list", { name: "Progress by table" })).toContainText("Contacts");
    await expectNoSeriousViolations(page);

    // A reload shows the summary again after the token.
    await page.reload();
    await page.getByLabel("Setup token").fill(SETUP_TOKEN);
    await page.getByRole("button", { name: "Check the deployment" }).click();
    await expect(page.getByRole("heading", { name: "Restore complete" })).toBeVisible();

    // The owner exists now: no second restore.
    const again = await page.request.post(`${TARGET}/api/setup/restore/start`, {
      data: {
        token: SETUP_TOKEN,
        source: { kind: "r2", backupId: crypto.randomUUID() },
        passphrase: PASSPHRASE,
      },
      headers: { Origin: TARGET },
    });
    expect(again.status()).toBe(404);

    // The owner signs in again with the password of the source.
    await page.getByRole("link", { name: "Go to sign in" }).click();
    await signIn(page, TARGET);
    const banner = page.getByTestId("backup-banner");
    await expect(banner).toContainText(
      "Campaign sends wait until you confirm the age of the backup",
    );

    // The data and the suppression came with it.
    const contacts = (await apiGet(page, TARGET, "/contacts?limit=50")) as {
      items: { email: string }[];
    };
    expect(contacts.items.map((item) => item.email).sort()).toEqual([...CONTACTS].sort());
    const suppressions = (await apiGet(page, TARGET, "/suppressions")) as { items: unknown[] };
    expect(suppressions.items).toHaveLength(1);

    // The owner confirms the age of the backup, and the warning goes away.
    await banner.getByRole("link", { name: "Open the backup settings" }).click();
    const section = page.locator("#backups");
    await expect(section.getByText("Campaign sends wait for you")).toBeVisible();
    await section.getByRole("button", { name: "I checked. Allow sends" }).click();
    await expect(section.getByText("Campaign sends wait for you")).toHaveCount(0);
    await expect(page.getByTestId("backup-banner")).toHaveCount(0);
  });
});
