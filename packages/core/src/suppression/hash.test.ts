import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { seedCampaignWorkspace } from "../../test/campaign-fixtures";
import { TEST_SIGNING_KEY, type TestServices, testDb, testServices } from "../../test/fixtures";
import { estimateAudience } from "../campaigns/audience";
import { AudienceSchema } from "../campaigns/model";
import { contactsUpsert } from "../contacts/operations";
import { runOperation } from "../executor";
import { contactsErase } from "../gdpr/operations";
import { importsCreate, importsGet, importsPreview, importsStart } from "../import/operations";
import { runImportJob } from "../import/process";
import type { ImportJob } from "../services";
import {
  createEmailHasher,
  createPinnedEmailHasher,
  SUPPRESSION_KEY_SETTING,
  SuppressionKeyError,
} from "./hash";
import { suppressionsAdd, suppressionsList } from "./operations";

// The suppression hash key survives a SIGNING_KEY rotation: the old key moves to
// SIGNING_KEYS_RETIRED, and every suppression check still finds the address.

// Key A is the key of the other tests in this file, so their contact hashes match it.
const KEY_A = TEST_SIGNING_KEY;
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

async function clearPin() {
  await env.DB.prepare("DELETE FROM system_settings WHERE key = ?")
    .bind(SUPPRESSION_KEY_SETTING)
    .run();
}

async function servicesWith(secrets: string[]): Promise<TestServices> {
  const services = await testServices();
  services.hashEmail = await createPinnedEmailHasher(env.DB, secrets);
  return services;
}

beforeEach(clearPin);

describe("pinned suppression hash key", () => {
  it("keeps an address suppressed everywhere after a rotation from key A to key B", async () => {
    const db = testDb();
    const before = await servicesWith([KEY_A]);
    const seeded = await seedCampaignWorkspace(db, before, { contacts: 0 });
    const owner = seeded.principal;
    const tag = crypto.randomUUID().slice(0, 8);
    const blocked = `blocked.${tag}@example.net`;
    const erased = `erased.${tag}@example.net`;
    const late = `late.${tag}@example.net`;
    const runWith = (services: TestServices) => {
      return <T>(op: Parameters<typeof runOperation>[1], input: unknown) =>
        runOperation(owner, op, input, { db, services }) as Promise<T>;
    };

    // With key A: suppress one address and add a contact that is erased later.
    await runWith(before)(suppressionsAdd, { emails: [blocked] });
    const toErase = await runWith(before)<{ contact: { id: number } }>(contactsUpsert, {
      email: erased,
      consentBasis: "existing_customer",
    });

    // Rotate: B signs, A is retired.
    const after = await servicesWith([KEY_B, KEY_A]);
    const run = runWith(after);
    expect(await after.hashEmail(blocked)).toBe(await before.hashEmail(blocked));
    expect(await after.hashEmail(blocked)).not.toBe(
      await (await createEmailHasher(KEY_B))(blocked),
    );

    // The suppression list check.
    const listed = await run<{ items: { reason: string }[] }>(suppressionsList, { email: blocked });
    expect(listed.items).toEqual([expect.objectContaining({ reason: "manual" })]);

    // The upsert, and the snapshot and send-time checks through the audience query.
    const upserted = await run<{ contact: { status: string } }>(contactsUpsert, {
      email: blocked,
      consentBasis: "existing_customer",
      listIds: [seeded.listId],
    });
    expect(upserted.contact.status).toBe("suppressed");
    const estimate = await estimateAudience(
      db,
      seeded.workspaceId,
      AudienceSchema.parse({ listIds: [seeded.listId] }),
      "regular",
    );
    expect(estimate.excluded.suppressed).toBe(1);
    expect(estimate.recipients).toBe(0);

    // The erase of a contact that key A hashed, and an upsert of that address after it.
    await run(contactsErase, { id: toErase.contact.id, confirm: erased });
    const again = await run<{ contact: { status: string; suppressionReason: string } }>(
      contactsUpsert,
      { email: erased },
    );
    expect(again.contact).toMatchObject({ status: "suppressed", suppressionReason: "erased" });

    // The import.
    const upload = await run<{ id: number }>(importsCreate, {
      filename: "students.csv",
      content: `email\r\n${blocked}\r\n${late}\r\n`,
    });
    await run(importsPreview, {
      id: upload.id,
      mapping: ["email"],
      consentBasis: "existing_customer",
      listIds: [seeded.listId],
    });
    await runImportJob({ db, services: after }, after.jobs.at(-1) as ImportJob);
    await run(importsStart, { id: upload.id });
    await runImportJob({ db, services: after }, after.jobs.at(-1) as ImportJob);
    const done = await run<{ counts: Record<string, number> }>(importsGet, { id: upload.id });
    expect(done.counts).toMatchObject({ new: 1, skippedSuppressed: 1 });
  });

  it("finds the key of existing hashes when the rotation happens before the first use", async () => {
    const db = testDb();
    const keyA = await servicesWith([KEY_A]);
    const seeded = await seedCampaignWorkspace(db, keyA, { contacts: 0 });
    await runOperation(
      seeded.principal,
      contactsUpsert,
      { email: `first.${crypto.randomUUID().slice(0, 8)}@example.net` },
      { db, services: keyA },
    );
    await clearPin();

    const rotated = await createPinnedEmailHasher(env.DB, [KEY_B, KEY_A]);
    expect(await rotated("someone@example.net")).toBe(await keyA.hashEmail("someone@example.net"));
  });

  it("fails instead of hashing with another key when the pinned key is gone", async () => {
    await createPinnedEmailHasher(env.DB, [KEY_A]);
    await expect(createPinnedEmailHasher(env.DB, [KEY_B])).rejects.toThrow(SuppressionKeyError);
  });
});
