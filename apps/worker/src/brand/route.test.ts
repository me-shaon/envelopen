import { env } from "cloudflare:workers";
import {
  brandUpdate,
  brandUploadLogo,
  campaignsConfirm,
  campaignsPrepare,
  campaignsPreview,
  runOperation,
} from "@envelopen/core";
import { createDraft, seedCampaignWorkspace } from "@envelopen/core/testing/campaign-fixtures";
import { describe, expect, it } from "vitest";
import {
  campaignDb,
  recordingQueue,
  snapshot,
  T0,
  testDeps,
  testKeys,
} from "../../test/campaign-helpers";
import { processPointer } from "../queue/send-consumer";
import { createBrandRoutes } from "./route";

// The brand kit at send time and the public logo route (U13, AE5, KTD10).

const ORIGIN = "https://envelopen.test";

const BRANDED_HTML =
  '<html><body><img src="{{ brand.logo_url }}" alt="{{ brand.name }}" width="160">' +
  '<p style="color:{{ brand.color_primary }}">{{ brand.name }}</p>' +
  '<p>Hello {{ first_name | default: "there" }}</p>' +
  '<p><a href="https://example.com/course">See the course</a></p>' +
  '<p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p></body></html>';

/** A PNG header with an IHDR chunk. */
function png(salt: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, 200);
  new DataView(bytes.buffer).setUint32(20, 60);
  bytes[39] = salt;
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const brand = (colorPrimary: string, name: string) => ({
  name,
  colorPrimary,
  colorAccent: "#ffffff",
  font: "system",
  footer: "",
  address: "1 Course Street, Springfield",
  social: {},
});

async function setup(options: { provider?: string; contacts?: number } = {}) {
  const db = campaignDb();
  const { credentials, hashEmail } = await testKeys();
  const seeded = await seedCampaignWorkspace(
    db,
    { credentials, hashEmail },
    { contacts: options.contacts ?? 1, provider: options.provider, html: BRANDED_HTML },
  );
  const services = {
    bucket: env.BUCKET,
    appOrigin: ORIGIN,
    startCampaignJob: async () => {},
  };
  const run = <T>(op: Parameters<typeof runOperation>[1], input: unknown) =>
    runOperation(seeded.principal, op, input, { db, services, now: () => T0 }) as Promise<T>;
  return { db, seeded, run };
}

describe("brand at send time", () => {
  it("covers AE5: the batches keep the brand of confirm time after a brand change", async () => {
    // 30 recipients on SES (batch size 25): two batches.
    const { db, seeded, run } = await setup({ provider: "ses", contacts: 30 });
    await run(brandUpdate, brand("#112233", "Acme"));
    const logo = await run<{ logo: { url: string } }>(brandUploadLogo, {
      filename: "logo.png",
      content: base64(png(1)),
    });
    const campaignId = await createDraft(db, seeded);
    const prepared = await run<{ token: string }>(campaignsPrepare, {
      id: campaignId,
      mode: "send_now",
    });
    await run(campaignsConfirm, { id: campaignId, token: prepared.token });
    const queue = recordingQueue();
    await snapshot(db, { workspaceId: seeded.workspaceId, campaignId, startedAt: T0 }, queue);
    expect(queue.sent).toHaveLength(2);

    const deps = await testDeps(db);
    await processPointer(deps, queue.sent[0]);
    const firstCalls = deps.mock.calls.length;
    // The owner changes the brand while the campaign sends.
    await run(brandUpdate, brand("#445566", "Acme Two"));
    await run(brandUploadLogo, { filename: "logo.png", content: base64(png(2)) });
    await processPointer(deps, queue.sent[1]);
    expect(deps.mock.calls.length).toBeGreaterThan(firstCalls);

    for (const call of deps.mock.calls) {
      // The sent HTML has the literal brand color in the inline style.
      expect(call.body).toContain("color:#112233");
      expect(call.body).toContain(">Acme</p>");
      expect(call.body).toContain(logo.logo.url);
      expect(call.body).not.toContain("#445566");
      expect(call.body).not.toContain("{{ brand.");
    }
    // A new draft shows the new brand.
    const draft = await createDraft(db, seeded);
    const preview = await run<{ html: string }>(campaignsPreview, { id: draft });
    expect(preview.html).toContain("color:#445566");
    // The logo of the confirmed campaign is still served.
    const response = await createBrandRoutes().request(
      `/${logo.logo.url.split("/b/")[1]}`,
      {},
      env,
    );
    expect(response.status).toBe(200);
  });
});

describe("logo route", () => {
  it("serves the stored type with nosniff and a long cache, and refuses other paths", async () => {
    const { db, seeded, run } = await setup();
    const out = await run<{ logo: { url: string } }>(brandUploadLogo, {
      content: base64(png(3)),
    });
    expect(out.logo.url).toMatch(
      new RegExp(`^${ORIGIN}/b/${seeded.workspaceId}/[0-9a-f]{64}\\.png$`),
    );
    const path = `/${out.logo.url.split("/b/")[1]}`;
    const app = createBrandRoutes();
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png(3));

    for (const bad of [
      `/${seeded.workspaceId}/not-a-logo.png`,
      `/${seeded.workspaceId}/${"a".repeat(64)}.svg`,
      `/${seeded.workspaceId}/${"a".repeat(64)}.png`,
      "/0/x.png",
    ]) {
      expect((await app.request(bad, {}, env)).status, bad).toBe(404);
    }

    // A restored deployment has the row but not the object: the route serves the row's
    // bytes and writes the object back.
    const key = `brand/${path.slice(1)}`;
    await env.BUCKET.delete(key);
    const restored = await app.request(path, {}, env);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(png(3));
    expect(await env.BUCKET.head(key)).not.toBeNull();
    expect(
      await db.db
        .selectFrom("brand_logos")
        .select("size")
        .where("workspace_id", "=", seeded.workspaceId)
        .where("key", "=", key)
        .executeTakeFirst(),
    ).toEqual({ size: 40 });
  });
});
