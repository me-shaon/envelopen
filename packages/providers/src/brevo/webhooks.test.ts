import { describe, expect, it, vi } from "vitest";
import { brevoEvent, brevoFixtures, brevoRequest } from "../../conformance/fixtures/smtp";
import * as encoding from "../shared/encoding";
import { bearerToken, parseBrevoEvents, verifyBrevoWebhook } from "./webhooks";

// The Brevo webhook receiver of the SMTP adapter (KTD13).

const REFS = brevoFixtures.refs;
const TOKEN = brevoFixtures.token;

describe("Brevo webhooks", () => {
  it("accepts the connection's bearer token", () => {
    expect(verifyBrevoWebhook(brevoRequest(brevoEvent("spam")), TOKEN, REFS)).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong bearer token through the constant-time compare", () => {
    const compare = vi.spyOn(encoding, "timingSafeEqual");
    const wrong = `${TOKEN.slice(0, -1)}x`;
    for (const token of [wrong, "short", ""]) {
      compare.mockClear();
      const result = verifyBrevoWebhook(brevoRequest(brevoEvent("spam"), token), TOKEN, REFS);
      expect(result.ok).toBe(false);
      // The compare runs for every request, also without a token.
      expect(compare).toHaveBeenCalledTimes(1);
    }
    const noHeader = brevoRequest(brevoEvent("spam"));
    noHeader.headers.delete("authorization");
    compare.mockClear();
    expect(verifyBrevoWebhook(noHeader, TOKEN, REFS).ok).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it("rejects an empty secret, a token in the URL, and connections without the Brevo preset", () => {
    const request = brevoRequest(brevoEvent("spam"));
    expect(verifyBrevoWebhook(request, "", REFS).ok).toBe(false);
    const inUrl = brevoRequest(
      brevoEvent("spam"),
      TOKEN,
      `${brevoFixtures.hookUrl}?token=${TOKEN}`,
    );
    expect(verifyBrevoWebhook(inUrl, TOKEN, REFS)).toEqual({
      ok: false,
      reason: "Envelopen does not accept a token in the URL.",
    });
    expect(verifyBrevoWebhook(request, TOKEN, { preset: "gmail" }).ok).toBe(false);
    expect(verifyBrevoWebhook(request, TOKEN, {}).ok).toBe(false);
  });

  it("reads only a Bearer Authorization header", () => {
    expect(bearerToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(bearerToken(new Headers({ authorization: "bearer abc " }))).toBe("abc");
    expect(bearerToken(new Headers({ authorization: "Basic abc" }))).toBe("");
    expect(bearerToken(new Headers({ authorization: "Bearer a b" }))).toBe("");
  });

  it("maps the unsubscribe event to an unsubscribe and gives replays the same id", () => {
    const parsed = parseBrevoEvents(brevoRequest(brevoEvent("unsubscribed")));
    expect(parsed.events).toEqual([]);
    expect(parsed.unsubscribes).toEqual([
      {
        eventId: expect.stringContaining("brevo:unsubscribed:"),
        email: "student1@example.org",
        providerMessageId: "<0123456789abcdef0123456789abcdef@mail.example.com>",
        occurredAt: brevoFixtures.now,
      },
    ]);
    const again = parseBrevoEvents(brevoRequest(brevoEvent("unsubscribed")));
    expect(again.unsubscribes?.[0]?.eventId).toBe(parsed.unsubscribes?.[0]?.eventId);
  });

  it("reads a batched array, skips unknown events, and ignores a body that is not JSON", () => {
    const parsed = parseBrevoEvents(
      brevoRequest([
        brevoEvent("hard_bounce"),
        brevoEvent("click"),
        brevoEvent("spam", { email: "student2@example.org" }),
        { event: "spam" },
      ]),
    );
    expect(parsed.events.map((event) => [event.type, event.email])).toEqual([
      ["bounce_hard", "student1@example.org"],
      ["complaint", "student2@example.org"],
    ]);
    expect(parseBrevoEvents({ ...brevoRequest({}), body: "not json" }).events).toEqual([]);
  });

  it("uses ts_event in seconds when ts_epoch is missing", () => {
    const { ts_epoch: _drop, ...event } = brevoEvent("soft_bounce");
    const parsed = parseBrevoEvents(brevoRequest(event));
    expect(parsed.events[0]?.occurredAt).toBe(brevoFixtures.now);
  });
});
