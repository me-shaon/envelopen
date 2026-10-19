import { describe, expect, it } from "vitest";
import { campaignBatch, campaignMessage } from "../../conformance/fixtures/messages";
import { resendAdapter } from "../resend";
import type { ProviderAdapter } from "../types";
import { assertMessages, MessageError, sendBatch } from "./messages";

describe("message contract", () => {
  it("accepts campaign messages with both unsubscribe headers", () => {
    expect(() => assertMessages(campaignBatch(3), 50)).not.toThrow();
  });

  it("rejects a campaign or test message without List-Unsubscribe-Post", () => {
    const message = campaignMessage(1);
    const { "List-Unsubscribe-Post": _dropped, ...headers } = message.headers;
    expect(() => assertMessages([{ ...message, headers }], 50)).toThrow(MessageError);
    expect(() => assertMessages([{ ...message, kind: "test", headers }], 50)).toThrow(
      /List-Unsubscribe-Post/,
    );
  });

  it("rejects a List-Unsubscribe without an HTTPS URL", () => {
    const message = campaignMessage(1);
    const headers = { ...message.headers, "List-Unsubscribe": "<mailto:u@example.com>" };
    expect(() => assertMessages([{ ...message, headers }], 50)).toThrow(/HTTPS/);
  });

  it("lets a system message go without unsubscribe headers", () => {
    expect(() =>
      assertMessages([{ ...campaignMessage(1), kind: "system", headers: {} }], 50),
    ).not.toThrow();
  });

  it("rejects header injection, duplicates, empty and oversized batches", () => {
    const message = campaignMessage(1);
    expect(() =>
      assertMessages(
        [{ ...message, headers: { ...message.headers, "X-Test": "a\r\nBcc: x@example.com" } }],
        50,
      ),
    ).toThrow(/line break/);
    expect(() => assertMessages([message, message], 50)).toThrow(/twice/);
    expect(() => assertMessages([], 50)).toThrow(/empty/);
    expect(() => assertMessages(campaignBatch(3), 2)).toThrow(/limit is 2/);
  });

  it("turns a missing adapter result into unknown, so no recipient is lost", async () => {
    const lossy: ProviderAdapter = {
      ...resendAdapter,
      async sendBatch(messages) {
        return {
          results: [
            {
              recipientId: messages[0]?.recipientId ?? "",
              outcome: "sent",
              providerMessageId: "m1",
            },
          ],
        };
      },
    };
    const result = await sendBatch(lossy, campaignBatch(2), {}, { fetch, refs: {} });
    expect(result.results).toEqual([
      { recipientId: "r1", outcome: "sent", providerMessageId: "m1" },
      expect.objectContaining({ recipientId: "r2", outcome: "unknown" }),
    ]);
  });
});
