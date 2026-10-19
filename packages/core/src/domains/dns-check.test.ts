import { resendFixtures } from "@envelopen/providers/conformance/fixtures/resend";
import { mockFetch } from "@envelopen/providers/conformance/mock-fetch";
import { describe, expect, it } from "vitest";
import { dohFetch, type Zone } from "../../test/doh";
import { createOwnedWorkspace, createUser, testDb, testServices } from "../../test/fixtures";
import { connectionsCreate } from "../connections/operations";
import { runOperation } from "../executor";
import { apiKeyPrincipal, sessionPrincipal } from "../principal";
import { onboardingStatus } from "../registry/operations/onboarding";
import {
  checkDkim,
  checkDmarc,
  checkSpf,
  checkTracking,
  createDohClient,
  joinTxt,
} from "./dns-check";
import { domainsCheck, domainsCreate, domainsGet, domainsList, domainsUpdate } from "./operations";

const DOMAIN = "mail.example.com";

const GOOD_ZONE: Zone = {
  [`TXT send.${DOMAIN}`]: ["v=spf1 include:amazonses.com ~all"],
  [`TXT resend._domainkey.${DOMAIN}`]: ["p=MIGfMA0GCSqGSIb3DQEB"],
  [`TXT _dmarc.${DOMAIN}`]: ["v=DMARC1; p=none; rua=mailto:dmarc@mail.example.com"],
  [`CNAME track.${DOMAIN}`]: ["envelopen.test"],
};

describe("DNS over HTTPS checks", () => {
  it("passes SPF, DKIM, DMARC, and the tracking CNAME", async () => {
    const doh = createDohClient(dohFetch(GOOD_ZONE).fetch);
    expect(await checkSpf(doh, [DOMAIN, `send.${DOMAIN}`], "amazonses.com")).toMatchObject({
      status: "pass",
    });
    expect(
      await checkDkim(doh, [{ host: `resend._domainkey.${DOMAIN}`, type: "TXT" }]),
    ).toMatchObject({
      status: "pass",
    });
    expect(await checkDmarc(doh, DOMAIN)).toEqual({ status: "pass", detail: "Policy none." });
    expect(await checkTracking(doh, fetch, `track.${DOMAIN}`, "envelopen.test")).toMatchObject({
      status: "pass",
    });
  });

  it("reports missing records as missing, not failed", async () => {
    const doh = createDohClient(dohFetch({}).fetch);
    expect((await checkSpf(doh, [DOMAIN], "amazonses.com")).status).toBe("missing");
    expect((await checkDkim(doh, [{ host: `s1._domainkey.${DOMAIN}`, type: "TXT" }])).status).toBe(
      "missing",
    );
    expect((await checkDmarc(doh, DOMAIN)).status).toBe("missing");
    expect((await checkTracking(doh, fetch, `track.${DOMAIN}`, "envelopen.test")).status).toBe(
      "missing",
    );
    expect((await checkDkim(doh, [])).status).toBe("unknown");
    expect((await checkTracking(doh, fetch, null, "envelopen.test")).status).toBe("unknown");
  });

  it("fails on wrong records", async () => {
    const doh = createDohClient(
      dohFetch({
        [`TXT ${DOMAIN}`]: ["v=spf1 include:a.example ~all", "v=spf1 include:b.example ~all"],
        [`TXT _dmarc.${DOMAIN}`]: ["v=DMARC1; rua=mailto:x@example.com"],
        [`CNAME track.${DOMAIN}`]: ["somewhere.else.example"],
        [`CNAME tok1._domainkey.${DOMAIN}`]: ["tok9.dkim.amazonses.com"],
      }).fetch,
    );
    expect(await checkSpf(doh, [DOMAIN], "amazonses.com")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("2 SPF records"),
    });
    expect((await checkDmarc(doh, DOMAIN)).status).toBe("fail");
    expect((await checkTracking(doh, fetch, `track.${DOMAIN}`, "envelopen.test")).status).toBe(
      "fail",
    );
    expect(
      (
        await checkDkim(doh, [
          { host: `tok1._domainkey.${DOMAIN}`, type: "CNAME", value: "tok1.dkim.amazonses.com" },
        ])
      ).status,
    ).toBe("fail");
    const single = createDohClient(
      dohFetch({ [`TXT ${DOMAIN}`]: ["v=spf1 include:other.example -all"] }).fetch,
    );
    expect(await checkSpf(single, [DOMAIN], "amazonses.com")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("does not include amazonses.com"),
    });
  });

  it.each([
    ["an HTTP error", "status" as const],
    ["a network error", "network" as const],
    ["SERVFAIL", "servfail" as const],
  ])("reports %s as an error, never as a failure", async (_label, fail) => {
    const doh = createDohClient(dohFetch(GOOD_ZONE, { fail }).fetch);
    expect((await checkSpf(doh, [DOMAIN], "amazonses.com")).status).toBe("error");
    expect((await checkDkim(doh, [{ host: "a._domainkey.x.example", type: "TXT" }])).status).toBe(
      "error",
    );
    expect((await checkDmarc(doh, DOMAIN)).status).toBe("error");
    expect((await checkTracking(doh, fetch, `track.${DOMAIN}`, "envelopen.test")).status).toBe(
      "error",
    );
  });

  it("accepts a Workers custom domain that answers the health route", async () => {
    const zone = { [`A track.${DOMAIN}`]: ["104.21.0.1"] };
    const health = mockFetch([
      {
        label: "health",
        method: "GET",
        url: `https://track.${DOMAIN}/api/health`,
        response: { status: 200, body: { status: "ok" } },
      },
    ]);
    const doh = createDohClient(dohFetch(zone).fetch);
    expect(
      await checkTracking(doh, health.fetch, `track.${DOMAIN}`, "envelopen.test"),
    ).toMatchObject({ status: "pass" });
    const elsewhere = mockFetch([
      {
        label: "other site",
        method: "GET",
        url: `https://track.${DOMAIN}/api/health`,
        response: { status: 404 },
      },
    ]);
    expect(
      (await checkTracking(doh, elsewhere.fetch, `track.${DOMAIN}`, "envelopen.test")).status,
    ).toBe("fail");
  });

  it("joins split TXT strings", () => {
    expect(joinTxt('"v=spf1 " "include:amazonses.com ~all"')).toBe(
      "v=spf1 include:amazonses.com ~all",
    );
    expect(joinTxt("plain")).toBe("plain");
  });
});

async function ownerWithResend(zone: Zone) {
  const db = testDb();
  const userId = await createUser(db);
  const workspaceId = await createOwnedWorkspace(db, userId, "Domains");
  const principal = sessionPrincipal({ workspaceId, userId });
  const provider = mockFetch([
    resendFixtures.domainsOk,
    resendFixtures.webhookCreated,
    resendFixtures.domainDetail,
  ]);
  const doh = dohFetch(zone, { fallback: provider.fetch });
  const services = await testServices({ fetch: doh.fetch });
  await runOperation(
    principal,
    connectionsCreate,
    { provider: "resend", credentials: { apiKey: "re_key_1" } },
    { db, services },
  );
  return { db, workspaceId, principal, services, doh };
}

describe("sending domain operations", () => {
  it("lists the provider's records, checks them, and verifies the domain", async () => {
    const { db, principal, services, workspaceId } = await ownerWithResend(GOOD_ZONE);
    const domain = await runOperation(
      principal,
      domainsCreate,
      { domain: " Mail.Example.com. ", trackingDomain: `track.${DOMAIN}` },
      { db, services },
    );
    expect(domain).toMatchObject({
      domain: DOMAIN,
      status: "verified",
      spf: { status: "pass" },
      dkim: { status: "pass" },
      dmarc: { status: "pass" },
      tracking: { status: "pass" },
    });
    expect(domain.records.map((record) => [record.purpose, record.host])).toEqual([
      ["return_path", `send.${DOMAIN}`],
      ["spf", `send.${DOMAIN}`],
      ["dkim", `resend._domainkey.${DOMAIN}`],
      ["dmarc", `_dmarc.${DOMAIN}`],
      ["tracking", `track.${DOMAIN}`],
    ]);
    const status = await runOperation(principal, onboardingStatus, {}, { db });
    expect(status.steps[1]).toMatchObject({ id: "verify_domain", status: "done" });
    // Keys with stats:read and MCP can read the status.
    const key = apiKeyPrincipal({
      workspaceId,
      apiKeyId: 3,
      scopes: ["stats:read"],
      surface: "mcp",
    });
    expect((await runOperation(key, domainsList, {}, { db })).items).toHaveLength(1);
    expect(await runOperation(key, domainsGet, { id: domain.id }, { db })).toMatchObject({
      status: "verified",
    });
    await expect(
      runOperation(key, domainsCheck, { id: domain.id }, { db, services }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("waits while records are missing, and keeps a DoH failure apart from a DNS failure", async () => {
    const { db, principal, services } = await ownerWithResend({});
    const domain = await runOperation(
      principal,
      domainsCreate,
      { domain: DOMAIN },
      { db, services },
    );
    expect(domain).toMatchObject({ status: "pending", dmarc: { status: "missing" } });
    expect((await runOperation(principal, onboardingStatus, {}, { db })).steps[1]?.status).toBe(
      "waiting",
    );

    const broken = await testServices({ fetch: dohFetch({}, { fail: "network" }).fetch });
    const checked = await runOperation(
      principal,
      domainsCheck,
      { id: domain.id },
      { db, services: broken },
    );
    expect(checked).toMatchObject({
      status: "pending",
      spf: { status: "error" },
      dmarc: { status: "error" },
    });
  });

  it("blocks the checklist on a failed record, and unverifies a domain whose record breaks", async () => {
    const { db, principal, services } = await ownerWithResend(GOOD_ZONE);
    const domain = await runOperation(
      principal,
      domainsCreate,
      { domain: DOMAIN },
      { db, services },
    );
    expect(domain.verifiedAt).not.toBeNull();
    const broken = await testServices({
      fetch: dohFetch({
        ...GOOD_ZONE,
        [`TXT _dmarc.${DOMAIN}`]: ["v=DMARC1; p=none", "v=DMARC1; p=reject"],
      }).fetch,
    });
    const checked = await runOperation(
      principal,
      domainsCheck,
      { id: domain.id },
      { db, services: broken },
    );
    expect(checked).toMatchObject({
      status: "failed",
      verifiedAt: null,
      dmarc: { status: "fail" },
    });
    const step = (await runOperation(principal, onboardingStatus, {}, { db })).steps[1];
    expect(step).toMatchObject({ status: "blocked", detail: expect.stringContaining("DMARC") });
  });

  it("uses DKIM selectors that the owner enters", async () => {
    const { db, principal, services } = await ownerWithResend({});
    const domain = await runOperation(
      principal,
      domainsCreate,
      { domain: "news.example.org" },
      { db, services },
    );
    const zone = { "TXT pm2026._domainkey.news.example.org": ["k=rsa; p=MIGf"] };
    const withKey = await testServices({
      fetch: dohFetch(zone, { fallback: mockFetch([]).fetch }).fetch,
    });
    const updated = await runOperation(
      principal,
      domainsUpdate,
      { id: domain.id, dkimSelectors: ["pm2026"] },
      { db, services: withKey },
    );
    expect(updated.dkim).toMatchObject({ status: "pass" });
    expect(updated.dkimSelectors).toEqual(["pm2026"]);
  });

  it("rejects invalid and duplicate domains, and keeps domains per workspace", async () => {
    const { db, principal, services } = await ownerWithResend(GOOD_ZONE);
    await expect(
      runOperation(principal, domainsCreate, { domain: "not a domain" }, { db, services }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await runOperation(principal, domainsCreate, { domain: DOMAIN }, { db, services });
    await expect(
      runOperation(principal, domainsCreate, { domain: DOMAIN }, { db, services }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const other = await ownerWithResend(GOOD_ZONE);
    expect((await runOperation(other.principal, domainsList, {}, { db: other.db })).items).toEqual(
      [],
    );
  });
});
