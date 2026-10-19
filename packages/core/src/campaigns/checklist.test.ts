import { describe, expect, it } from "vitest";
import { addContacts, createDraft, seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { runOperation } from "../executor";
import { campaignsChecklist, campaignsEstimate } from "./operations";

type Checklist = {
  blocked: boolean;
  items: { id: string; status: string; fix: { path: string } | null }[];
};

async function checklist(options: Parameters<typeof seedCampaignWorkspace>[2]) {
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, { contacts: 2, ...options });
  const id = await createDraft(db, seeded);
  const result = (await runOperation(
    seeded.principal,
    campaignsChecklist,
    { id },
    { db, services },
  )) as Checklist;
  return { result, item: (name: string) => result.items.find((entry) => entry.id === name) };
}

describe("pre-send checklist", () => {
  it("passes for a ready campaign", async () => {
    const { result } = await checklist({});
    expect(result.blocked).toBe(false);
    expect(result.items.filter((item) => item.status === "fail")).toEqual([]);
  });

  it("fails when the unsubscribe link is missing", async () => {
    const { result, item } = await checklist({
      html: "<html><body><p>No way out</p></body></html>",
    });
    expect(result.blocked).toBe(true);
    expect(item("unsubscribe_link")).toMatchObject({
      status: "fail",
      fix: { path: expect.stringMatching(/^\/templates\//) },
    });
  });

  it("fails when domain authentication is missing", async () => {
    const { result, item } = await checklist({ unverifiedDomain: true });
    expect(result.blocked).toBe(true);
    expect(item("domain_auth")).toMatchObject({
      status: "fail",
      fix: { path: expect.stringMatching(/^\/connections\/domains\/\d+$/) },
    });
  });

  it("warns when the Free plan budget is too small for the campaign", async () => {
    const db = testDb();
    const services = await testServices();
    services.usageStatus = { ...services.usageStatus, rowsWritten: 99_999 };
    const seeded = await seedCampaignWorkspace(db, services, { contacts: 2 });
    const id = await createDraft(db, seeded);
    const result = (await runOperation(
      seeded.principal,
      campaignsChecklist,
      { id },
      { db, services },
    )) as Checklist;
    expect(result.items.find((entry) => entry.id === "free_budget")).toMatchObject({
      status: "warn",
    });
    expect(result.blocked).toBe(false);
  });
});

describe("audience estimate", () => {
  it("covers AE1: a regular campaign leaves out unknown consent with the reason, a re-permission campaign includes it", async () => {
    const db = testDb();
    const services = await testServices();
    const seeded = await seedCampaignWorkspace(db, services, { contacts: 3 });
    await addContacts(db, services.hashEmail, seeded.workspaceId, seeded.listId, 2, {
      consent: "unknown",
      prefix: "old",
    });
    const regular = await createDraft(db, seeded);
    const repermission = await createDraft(db, seeded, { type: "re-permission" });
    const estimate = (id: number) =>
      runOperation(seeded.principal, campaignsEstimate, { id }, { db, services });
    expect(await estimate(regular)).toEqual({
      recipients: 3,
      excluded: { consent_unknown: 2, suppressed: 0, unsubscribed: 0 },
      isEstimate: true,
    });
    expect(await estimate(repermission)).toEqual({
      recipients: 5,
      excluded: { consent_unknown: 0, suppressed: 0, unsubscribed: 0 },
      isEstimate: true,
    });
  });
});
