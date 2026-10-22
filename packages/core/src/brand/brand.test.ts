import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_HTML,
  createDraft,
  seedCampaignWorkspace,
  TEST_POSTAL_ADDRESS,
} from "../../test/campaign-fixtures";
import { testDb, testServices } from "../../test/fixtures";
import { loadCampaign } from "../campaigns/model";
import {
  campaignsChecklist,
  campaignsConfirm,
  campaignsPrepare,
  campaignsPreview,
  campaignsUnschedule,
} from "../campaigns/operations";
import { isOperationError } from "../errors";
import { runOperation } from "../executor";
import { apiKeyPrincipal } from "../principal";
import { templatesPreview } from "../templates/operations";
import { checkLogo, sniffImage } from "./logo";
import { LOGO_MAX_BYTES, parseLogoPath } from "./model";
import { brandGet, brandRemoveLogo, brandUpdate, brandUploadLogo } from "./operations";

// The brand kit (U13, R18, R19, AE5, KTD10).

const T0 = Date.UTC(2026, 9, 22, 9);

const BRANDED_HTML =
  '<html><body><img src="{{ brand.logo_url }}" alt="{{ brand.name }}" width="160">' +
  '<p style="color:{{ brand.color_primary }};font-family:{{ brand.font }}">{{ brand.name }}</p>' +
  '<p>Hello {{ first_name | default: "there" }}</p>' +
  '<p><a href="{{ brand.social.x }}">X</a></p><p>{{ brand.address }}</p>' +
  '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>';

/** A PNG header with an IHDR chunk. `salt` changes the bytes, so the hash changes too. */
function png(width: number, height: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes[39] = salt;
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const text = (value: string) => new TextEncoder().encode(value);

interface BrandOut {
  name: string;
  colorPrimary: string;
  font: string;
  address: string;
  social: Record<string, string>;
  logo: { url: string; contentType: string; width: number | null; height: number | null } | null;
  tokens: { name: string };
}

function brandInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme Studio",
    colorPrimary: "#112233",
    colorAccent: "#ffeedd",
    font: "georgia",
    footer: "Made with care.",
    address: TEST_POSTAL_ADDRESS,
    social: { x: "https://x.com/acme" },
    ...overrides,
  };
}

async function setup(options: Parameters<typeof seedCampaignWorkspace>[2] = {}) {
  const db = testDb();
  const services = await testServices();
  const seeded = await seedCampaignWorkspace(db, services, {
    contacts: 2,
    html: BRANDED_HTML,
    ...options,
  });
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown, now = T0) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => now }) as Promise<T>;
  const confirm = async (campaignId: number, mode: "send_now" | "schedule" = "send_now") => {
    const prepared = await run<{ token: string | null }>(campaignsPrepare, {
      id: campaignId,
      mode,
      ...(mode === "schedule" ? { scheduledAt: T0 + 86_400_000 } : {}),
    });
    if (!prepared.token) throw new Error("The checklist blocked the send.");
    await run(campaignsConfirm, { id: campaignId, token: prepared.token }, T0 + 1000);
  };
  return { db, services, seeded, run, confirm };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOperationError(error)) {
      return { code: error.code, message: error.message, details: error.details };
    }
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

describe("brand kit", () => {
  it("covers AE5: a confirmed campaign keeps its brand, and drafts show the new one", async () => {
    const { db, seeded, run, confirm } = await setup();
    await run(brandUpdate, brandInput());
    const confirmed = await createDraft(db, seeded);
    const draft = await createDraft(db, seeded);
    await confirm(confirmed);

    const row = await loadCampaign(db, seeded.workspaceId, confirmed);
    expect(JSON.parse(row.brand_snapshot ?? "null")).toMatchObject({
      name: "Acme Studio",
      colorPrimary: "#112233",
      address: TEST_POSTAL_ADDRESS,
    });

    await run(brandUpdate, brandInput({ colorPrimary: "#445566", name: "Acme Two" }));
    const sent = await run<{ html: string }>(campaignsPreview, { id: confirmed });
    expect(sent.html).toContain("color:#112233;");
    expect(sent.html).toContain(">Acme Studio</p>");
    const fresh = await run<{ html: string }>(campaignsPreview, { id: draft });
    expect(fresh.html).toContain("color:#445566;");
    expect(fresh.html).toContain(">Acme Two</p>");
  });

  it("shows the brand name and the logo in the template preview", async () => {
    const { seeded, run } = await setup();
    await run(brandUpdate, brandInput());
    const brand = await run<BrandOut>(brandUploadLogo, {
      filename: "logo.png",
      content: base64(png(320, 80)),
    });
    expect(brand.logo).toMatchObject({ contentType: "image/png", width: 320, height: 80 });
    const preview = await run<{ html: string; missing: string[] }>(templatesPreview, {
      id: seeded.templateId,
    });
    expect(preview.html).toContain(`src="${brand.logo?.url}"`);
    expect(preview.html).toContain(">Acme Studio</p>");
    expect(preview.html).toContain("Georgia, Times New Roman, Times, serif");
    expect(preview.html).toContain("Hello Ada");
    expect(preview.missing).toEqual([]);
  });

  it("uses the workspace name and removes the logo image when the kit is empty", async () => {
    const { seeded, run } = await setup({ postalAddress: null, name: "Course Academy" });
    const brand = await run<BrandOut>(brandGet, {});
    expect(brand).toMatchObject({ name: "", tokens: { name: "Course Academy" }, logo: null });
    const preview = await run<{ html: string }>(templatesPreview, { id: seeded.templateId });
    expect(preview.html).not.toContain("<img");
    expect(preview.html).toContain(">Course Academy</p>");
  });

  it("never deletes a logo that was the kit logo, so sent emails keep their logo", async () => {
    const { db, seeded, run, confirm } = await setup();
    await run(brandUpdate, brandInput());
    const keyOf = (brand: BrandOut) =>
      parseLogoPath(brand.logo?.url.split("/b/")[1] ?? "")?.key ?? "";
    const first = keyOf(await run<BrandOut>(brandUploadLogo, { content: base64(png(100, 50, 1)) }));
    const campaignId = await createDraft(db, seeded);
    await confirm(campaignId);
    const snapshot = JSON.parse(
      (await loadCampaign(db, seeded.workspaceId, campaignId)).brand_snapshot ?? "{}",
    );
    expect(snapshot.logoKey).toBe(first);

    // A replaced logo stays, also one that no campaign uses (a welcome email may have it).
    const second = keyOf(
      await run<BrandOut>(brandUploadLogo, { content: base64(png(100, 50, 2)) }),
    );
    const third = keyOf(await run<BrandOut>(brandUploadLogo, { content: base64(png(100, 50, 3)) }));
    expect(new Set([first, second, third]).size).toBe(3);
    const removed = await run<BrandOut>(brandRemoveLogo, {});
    expect(removed.logo).toBeNull();
    for (const key of [first, second, third]) {
      expect(await env.BUCKET.head(key), key).not.toBeNull();
    }
    const rows = await db.db
      .selectFrom("brand_logos")
      .select("key")
      .where("workspace_id", "=", seeded.workspaceId)
      .orderBy("id")
      .execute();
    expect(rows.map((row) => row.key)).toEqual([first, second, third]);
  });

  it("blocks confirm without a postal address, with a fix link to the brand page", async () => {
    const { db, seeded, run } = await setup({ postalAddress: null });
    const campaignId = await createDraft(db, seeded);
    const checklist = await run<{
      blocked: boolean;
      items: { id: string; status: string; fix: { path: string } | null }[];
    }>(campaignsChecklist, { id: campaignId });
    expect(checklist.blocked).toBe(true);
    expect(checklist.items.find((item) => item.id === "postal_address")).toMatchObject({
      status: "fail",
      fix: { path: "/brand" },
    });
    const prepared = await run<{ token: string | null }>(campaignsPrepare, {
      id: campaignId,
      mode: "send_now",
    });
    expect(prepared.token).toBeNull();

    // An address cleared between prepare and confirm still blocks the confirm.
    await run(brandUpdate, brandInput());
    const ready = await run<{ token: string }>(campaignsPrepare, {
      id: campaignId,
      mode: "send_now",
    });
    await run(brandUpdate, brandInput({ address: "  " }));
    expect(
      await failure(run(campaignsConfirm, { id: campaignId, token: ready.token })),
    ).toMatchObject({ code: "conflict", details: { fix: "/brand" } });
  });

  it("clears the snapshot when a scheduled campaign goes back to draft", async () => {
    const { db, seeded, run, confirm } = await setup();
    await run(brandUpdate, brandInput());
    const campaignId = await createDraft(db, seeded);
    await confirm(campaignId, "schedule");
    expect((await loadCampaign(db, seeded.workspaceId, campaignId)).brand_snapshot).not.toBeNull();
    await run(campaignsUnschedule, { id: campaignId });
    expect((await loadCampaign(db, seeded.workspaceId, campaignId)).brand_snapshot).toBeNull();
  });

  it("refuses hostile values on save and escapes the text values in the email", async () => {
    const { seeded, run } = await setup();
    for (const [field, value] of [
      ["colorPrimary", "red;background:url(javascript:alert(1))"],
      ["colorAccent", "#12345"],
      ["font", "Comic Sans'; behavior:url(x)"],
    ] as const) {
      expect(await failure(run(brandUpdate, brandInput({ [field]: value })))).toMatchObject({
        code: "invalid_input",
      });
    }
    expect(
      await failure(run(brandUpdate, brandInput({ social: { x: "javascript:alert(1)" } }))),
    ).toMatchObject({ code: "invalid_input", details: { field: "social.x" } });
    expect(
      await failure(run(brandUpdate, brandInput({ social: { x: "http://x.com/acme" } }))),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await failure(run(brandUpdate, brandInput({ social: { myspace: "https://a.io" } }))),
    ).toMatchObject({ code: "invalid_input" });
    expect(await failure(run(brandUpdate, brandInput({ name: "Acme\u0000" })))).toMatchObject({
      code: "invalid_input",
    });

    const saved = await run<BrandOut>(
      brandUpdate,
      brandInput({ name: `Acme "Q" <b>&</b>`, address: "1 <script>alert(1)</script> St" }),
    );
    expect(saved.name).toBe(`Acme "Q" <b>&</b>`);
    const preview = await run<{ html: string }>(templatesPreview, { id: seeded.templateId });
    // No logo, so no image: the name shows as escaped text.
    expect(preview.html).toContain(">Acme &quot;Q&quot; &lt;b&gt;&amp;&lt;/b&gt;</p>");
    expect(preview.html).toContain("1 &lt;script&gt;alert(1)&lt;/script&gt; St");
    expect(preview.html).not.toContain("<script>");
  });

  it("accepts PNG, JPEG, GIF, and WebP by their bytes and refuses SVG and mismatches", async () => {
    const { run } = await setup();
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(
      await failure(run(brandUploadLogo, { filename: "logo.svg", content: base64(svg) })),
    ).toMatchObject({ code: "invalid_input", details: { field: "content" } });
    const html = text("<!doctype html><script>alert(1)</script>");
    expect(
      await failure(run(brandUploadLogo, { filename: "logo.png", content: base64(html) })),
    ).toMatchObject({ code: "invalid_input", details: { field: "content" } });
    expect(
      await failure(run(brandUploadLogo, { filename: "logo.gif", content: base64(png(10, 10)) })),
    ).toMatchObject({ code: "invalid_input", details: { field: "filename" } });
    expect(
      await failure(
        run(brandUploadLogo, { contentType: "image/svg+xml", content: base64(png(10, 10)) }),
      ),
    ).toMatchObject({ code: "invalid_input", details: { field: "contentType" } });
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set(png(10, 10));
    expect(await failure(run(brandUploadLogo, { content: base64(big) }))).toMatchObject({
      code: "invalid_input",
    });

    expect(sniffImage(text("GIF89a\u0010\u0000 \u0000"))).toEqual({
      contentType: "image/gif",
      width: 16,
      height: 32,
    });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 48, 0, 64, 3, 0, 0, 0,
    ]);
    expect(sniffImage(jpeg)).toEqual({ contentType: "image/jpeg", width: 64, height: 48 });
    const webp = new Uint8Array(30);
    webp.set(text("RIFF"), 0);
    webp.set(text("WEBPVP8X"), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(sniffImage(webp)).toEqual({ contentType: "image/webp", width: 100, height: 50 });
    expect(checkLogo(png(1, 1), { filename: "LOGO.PNG", contentType: "image/png" }, 100)).toEqual({
      ok: true,
      image: { contentType: "image/png", width: 1, height: 1 },
    });
  });

  it("lets an API key read the brand but not change it", async () => {
    const { db, services, seeded } = await setup();
    const principal = apiKeyPrincipal({
      workspaceId: seeded.workspaceId,
      apiKeyId: 1,
      scopes: ["campaigns:read", "campaigns:write", "templates:write"],
      surface: "rest",
    });
    await expect(runOperation(principal, brandGet, {}, { db, services })).resolves.toMatchObject({
      address: TEST_POSTAL_ADDRESS,
    });
    expect(
      await failure(runOperation(principal, brandUpdate, brandInput(), { db, services })),
    ).toMatchObject({ code: "forbidden" });
  });

  it("keeps the default HTML when the template has no brand tokens", async () => {
    const { db, seeded, run } = await setup({ html: CAMPAIGN_HTML });
    await run(brandUpdate, brandInput());
    const campaignId = await createDraft(db, seeded);
    const preview = await run<{ html: string }>(campaignsPreview, { id: campaignId });
    expect(preview.html).toContain("<p>Hello Ada</p>");
    expect(preview.html).not.toContain("Acme");
  });
});
