import { describe, expect, it } from "vitest";
import { resendFixtures } from "../../conformance/fixtures/resend";
import { mockFetch } from "../../conformance/mock-fetch";
import { resendAdapter } from "./index";
import { svixSign, verifySvix } from "./svix-verify";

// Published test vectors:
// A: https://docs.svix.com/receiving/verifying-payloads/how-manual
// B: svix-webhooks javascript/src/webhook.test.ts ("sign function works")
const VECTOR_A = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: "1731705121",
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
};
const VECTOR_B = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

function at(timestamp: string, offsetSeconds = 0): number {
  return (Number(timestamp) + offsetSeconds) * 1000;
}

describe("Svix verification", () => {
  it.each([
    ["the docs vector", VECTOR_A],
    ["the library vector", VECTOR_B],
  ])("accepts %s", async (_label, vector) => {
    expect(`v1,${await svixSign(vector.secret, vector.id, vector.timestamp, vector.body)}`).toBe(
      vector.signature,
    );
    const result = await verifySvix(
      vector.secret,
      { id: vector.id, timestamp: vector.timestamp, signature: vector.signature },
      vector.body,
      at(vector.timestamp, 10),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a timestamp older than 5 minutes, and one too far ahead", async () => {
    const headers = {
      id: VECTOR_A.id,
      timestamp: VECTOR_A.timestamp,
      signature: VECTOR_A.signature,
    };
    expect(
      await verifySvix(VECTOR_A.secret, headers, VECTOR_A.body, at(VECTOR_A.timestamp, 301)),
    ).toMatchObject({
      ok: false,
      reason: "The timestamp is outside the 5 minute window.",
    });
    expect(
      (await verifySvix(VECTOR_A.secret, headers, VECTOR_A.body, at(VECTOR_A.timestamp, 299))).ok,
    ).toBe(true);
    expect(
      (await verifySvix(VECTOR_A.secret, headers, VECTOR_A.body, at(VECTOR_A.timestamp, -301))).ok,
    ).toBe(false);
  });

  it("rejects a changed body, id, or timestamp, and a wrong secret", async () => {
    const now = at(VECTOR_A.timestamp);
    const base = { id: VECTOR_A.id, timestamp: VECTOR_A.timestamp, signature: VECTOR_A.signature };
    expect((await verifySvix(VECTOR_A.secret, base, `${VECTOR_A.body} `, now)).ok).toBe(false);
    expect(
      (await verifySvix(VECTOR_A.secret, { ...base, id: "msg_other" }, VECTOR_A.body, now)).ok,
    ).toBe(false);
    expect(
      (
        await verifySvix(
          VECTOR_A.secret,
          { ...base, timestamp: String(Number(VECTOR_A.timestamp) + 1) },
          VECTOR_A.body,
          now,
        )
      ).ok,
    ).toBe(false);
    expect((await verifySvix(VECTOR_B.secret, base, VECTOR_A.body, now)).ok).toBe(false);
    expect((await verifySvix("not base64 !!", base, VECTOR_A.body, now)).ok).toBe(false);
  });

  it("accepts any matching v1 signature in a rotated header, and ignores other versions", async () => {
    const now = at(VECTOR_A.timestamp);
    const rotated = `v1,bm9wZQ== v2,${VECTOR_A.signature.slice(3)} ${VECTOR_A.signature}`;
    const headers = { id: VECTOR_A.id, timestamp: VECTOR_A.timestamp, signature: rotated };
    expect(await verifySvix(VECTOR_A.secret, headers, VECTOR_A.body, now)).toEqual({ ok: true });
    const onlyV2 = { ...headers, signature: `v2,${VECTOR_A.signature.slice(3)}` };
    expect((await verifySvix(VECTOR_A.secret, onlyV2, VECTOR_A.body, now)).ok).toBe(false);
  });

  it("rejects missing headers", async () => {
    expect(
      await verifySvix(VECTOR_A.secret, { id: null, timestamp: null, signature: null }, "{}", 0),
    ).toMatchObject({
      ok: false,
    });
  });

  it("verifies a Resend webhook request through the adapter", async () => {
    const body = resendFixtures.events.bounced;
    const timestamp = "1792411200";
    const signature = await svixSign(resendFixtures.webhookSecret, "msg_1", timestamp, body);
    const request = {
      url: "https://envelopen.test/hooks/resend/1/2",
      method: "POST",
      headers: new Headers({
        "svix-id": "msg_1",
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      }),
      body,
    };
    const ctx = { fetch: mockFetch([]).fetch, refs: {}, now: () => at(timestamp, 5) };
    expect(await resendAdapter.verifyWebhook(request, resendFixtures.webhookSecret, ctx)).toEqual({
      ok: true,
    });
    expect(resendAdapter.parseEvents(request).events).toEqual([
      {
        type: "bounce_hard",
        eventId: "msg_1:student1@example.org",
        providerMessageId: "56761188-7520-42d8-8898-ff6fc54ce618",
        email: "student1@example.org",
        occurredAt: Date.parse("2026-10-19T12:00:00.000Z"),
        detail: "General",
      },
    ]);
    // The same delivery replayed after the window fails.
    const late = { ...ctx, now: () => at(timestamp, 600) };
    expect(
      (await resendAdapter.verifyWebhook(request, resendFixtures.webhookSecret, late)).ok,
    ).toBe(false);
  });
});
