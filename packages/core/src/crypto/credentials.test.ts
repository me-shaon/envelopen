import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createWorkspace, TEST_ENCRYPTION_KEY, testDb, testServices } from "../../test/fixtures";
import {
  decryptCredentials,
  decryptWebhookSecret,
  resealLegacyConnections,
} from "../connections/model";
import { CredentialKeyError, createCredentialCipher, isConnectionBound } from "./credentials";

const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const OWNER = { workspaceId: 1, purpose: "credentials" as const };

describe("credential encryption", () => {
  it("round-trips, and the stored value does not contain the plaintext", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const plaintext = JSON.stringify({ apiKey: "re_super_secret_value" });
    const sealed = await cipher.encrypt(plaintext, OWNER);
    expect(sealed).not.toContain("re_super_secret_value");
    expect(atob(sealed.split(".")[1] ?? "")).not.toContain("super_secret");
    expect(await cipher.decrypt(sealed, 1, OWNER)).toBe(plaintext);
  });

  it("uses a new IV each time", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    expect(await cipher.encrypt("same", OWNER)).not.toBe(await cipher.encrypt("same", OWNER));
  });

  it("fails with a wrong key, another workspace, another purpose, or a changed byte", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const wrong = await createCredentialCipher([{ version: 1, secret: OTHER_KEY }]);
    const sealed = await cipher.encrypt("secret", OWNER);
    await expect(wrong.decrypt(sealed, 1, OWNER)).rejects.toThrow(CredentialKeyError);
    await expect(
      cipher.decrypt(sealed, 1, { workspaceId: 2, purpose: "credentials" }),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(sealed, 1, { workspaceId: 1, purpose: "webhook_secret" }),
    ).rejects.toThrow();
    const [iv, body = ""] = sealed.split(".");
    const flipped = `${iv}.${body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`}`;
    await expect(cipher.decrypt(flipped, 1, OWNER)).rejects.toThrow();
    await expect(cipher.decrypt("not-a-ciphertext", 1, OWNER)).rejects.toThrow();
  });

  it("encrypts with the newest version and still decrypts older rows", async () => {
    const old = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const ring = await createCredentialCipher([
      { version: 1, secret: TEST_ENCRYPTION_KEY },
      { version: 2, secret: OTHER_KEY },
    ]);
    expect(ring.version).toBe(2);
    const legacy = await old.encrypt("v1 value", OWNER);
    expect(await ring.decrypt(legacy, 1, OWNER)).toBe("v1 value");
    await expect(ring.decrypt(legacy, 2, OWNER)).rejects.toThrow();
    await expect(old.decrypt(await ring.encrypt("v2", OWNER), 2, OWNER)).rejects.toThrow(
      /No key for version 2/,
    );
  });

  it("rejects a missing or short key", async () => {
    await expect(createCredentialCipher([])).rejects.toThrow(CredentialKeyError);
    await expect(createCredentialCipher([{ version: 1, secret: btoa("short") }])).rejects.toThrow(
      /32 bytes/,
    );
    await expect(
      createCredentialCipher([{ version: 0, secret: TEST_ENCRYPTION_KEY }]),
    ).rejects.toThrow();
  });
});

describe("connection binding (v2)", () => {
  it("binds a value to its connection and still decrypts values from before", async () => {
    const cipher = await createCredentialCipher([{ version: 1, secret: TEST_ENCRYPTION_KEY }]);
    const bound = await cipher.encrypt("secret", { ...OWNER, connectionId: 5 });
    expect(isConnectionBound(bound)).toBe(true);
    expect(await cipher.decrypt(bound, 1, { ...OWNER, connectionId: 5 })).toBe("secret");
    // A copy into another connection of the same workspace and purpose fails.
    await expect(cipher.decrypt(bound, 1, { ...OWNER, connectionId: 6 })).rejects.toThrow();
    await expect(cipher.decrypt(bound, 1, OWNER)).rejects.toThrow(CredentialKeyError);
    // A value from before v2 decrypts with or without the connection id.
    const legacy = await cipher.encrypt("old", OWNER);
    expect(isConnectionBound(legacy)).toBe(false);
    expect(await cipher.decrypt(legacy, 1, { ...OWNER, connectionId: 5 })).toBe("old");
  });

  it("writes legacy rows again bound to their connection", async () => {
    const services = await testServices();
    const cipher = services.credentials;
    const conn = testDb();
    const workspaceId = await createWorkspace(conn, "Reseal");
    const legacy = { workspaceId };
    const row = await conn.db
      .insertInto("provider_connections")
      .values({
        workspace_id: workspaceId,
        provider: "resend",
        name: "Resend",
        policy: "campaign",
        credentials_encrypted: await cipher.encrypt('{"apiKey":"re_x"}', {
          ...legacy,
          purpose: "credentials",
        }),
        credentials_key_version: 1,
        webhook_secret_encrypted: await cipher.encrypt("whsec_x", {
          ...legacy,
          purpose: "webhook_secret",
        }),
        events_setup: "auto",
        provider_refs: "{}",
        status: "active",
        status_detail: null,
        policy_warning_accepted_at: null,
        policy_warning_accepted_by: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // A copy of a legacy value into another connection of the workspace decrypts.
    expect(await decryptCredentials(services, { ...row, id: row.id + 1 })).toEqual({
      apiKey: "re_x",
    });

    expect(await resealLegacyConnections(conn, services, 1_000)).toBeGreaterThanOrEqual(1);
    const resealed = await conn.db
      .selectFrom("provider_connections")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(isConnectionBound(resealed.credentials_encrypted)).toBe(true);
    expect(isConnectionBound(resealed.webhook_secret_encrypted ?? "")).toBe(true);
    expect(await decryptCredentials(services, resealed)).toEqual({ apiKey: "re_x" });
    expect(await decryptWebhookSecret(services, resealed)).toBe("whsec_x");
    // Now a copy into another connection fails.
    await expect(decryptCredentials(services, { ...resealed, id: row.id + 1 })).rejects.toThrow();
    // A second run finds nothing to do for this row.
    await resealLegacyConnections(conn, services, 1_000);
    const again = await env.DB.prepare(
      "SELECT credentials_encrypted AS c FROM provider_connections WHERE id = ?",
    )
      .bind(row.id)
      .first<string>("c");
    expect(again).toBe(resealed.credentials_encrypted);
  });
});
