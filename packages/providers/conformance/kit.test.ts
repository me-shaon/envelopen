import { describe, expect, it } from "vitest";
import { cloudflareAdapter } from "../src/cloudflare";
import { resendAdapter } from "../src/resend";
import { LIST_UNSUBSCRIBE_POST } from "../src/shared/messages";
import { toSendAdapter } from "../src/tosend";
import type { OutgoingMessage, ProviderAdapter } from "../src/types";
import { type CheckReport, runChecks } from "./checks";
import { cloudflareConformance } from "./fixtures/cloudflare";
import { resendConformance } from "./fixtures/resend";
import { toSendConformance } from "./fixtures/tosend";

// The kit tests itself: each broken adapter below must fail the check that targets
// its fault, and pass the rest, so a pass of the suite means something.

function status(reports: CheckReport[], id: CheckReport["id"]): CheckReport | undefined {
  return reports.find((report) => report.id === id);
}

function failed(reports: CheckReport[]): string[] {
  return reports.filter((report) => report.status === "fail").map((report) => report.id);
}

function withoutHeader(message: OutgoingMessage, name: string): OutgoingMessage {
  const headers = Object.fromEntries(
    Object.entries(message.headers).filter(([key]) => key.toLowerCase() !== name.toLowerCase()),
  );
  return { ...message, headers };
}

describe("conformance kit", () => {
  it("passes a built-in adapter, and reports skips with their reason", async () => {
    const reports = await runChecks(cloudflareAdapter, cloudflareConformance);
    expect(failed(reports)).toEqual([]);
    expect(status(reports, "webhook.changed")).toEqual(
      expect.objectContaining({ status: "skip", reason: expect.stringContaining("no webhook") }),
    );
    expect(status(reports, "send.idempotency")).toMatchObject({ status: "skip" });
  });

  it("fails the header check for an adapter that drops List-Unsubscribe-Post", async () => {
    const broken: ProviderAdapter = {
      ...resendAdapter,
      sendBatch: (messages, credentials, ctx) =>
        resendAdapter.sendBatch(
          messages.map((message) => withoutHeader(message, LIST_UNSUBSCRIBE_POST)),
          credentials,
          ctx,
        ),
    };
    const reports = await runChecks(broken, resendConformance);
    expect(failed(reports)).toEqual(["send.headers"]);
    const report = status(reports, "send.headers");
    expect(report?.status === "fail" && report.problems.join("\n")).toContain(
      "List-Unsubscribe-Post: (missing)",
    );
  });

  it("fails the verification check for an adapter that accepts a changed payload", async () => {
    // It checks the signature against the body it first saw, not the body it got.
    const original = (await resendConformance.webhook?.valid())?.body ?? "";
    const broken: ProviderAdapter = {
      ...resendAdapter,
      verifyWebhook: (request, secret, ctx) =>
        resendAdapter.verifyWebhook({ ...request, body: original }, secret, ctx),
    };
    const reports = await runChecks(broken, resendConformance);
    expect(failed(reports)).toEqual(["webhook.changed"]);
  });

  it("fails an adapter that accepts any webhook", async () => {
    const broken: ProviderAdapter = { ...toSendAdapter, verifyWebhook: async () => ({ ok: true }) };
    const reports = await runChecks(broken, toSendConformance);
    expect(failed(reports)).toEqual(["webhook.changed", "webhook.wrong-secret"]);
  });

  it("fails a 207 mapping that shifts results to the wrong recipient", async () => {
    const broken: ProviderAdapter = {
      ...toSendAdapter,
      async sendBatch(messages, credentials, ctx) {
        const result = await toSendAdapter.sendBatch(messages, credentials, ctx);
        const outcomes = result.results.map((item) => item.outcome).reverse();
        return {
          ...result,
          results: result.results.map((item, index) => ({
            ...item,
            outcome: outcomes[index] ?? item.outcome,
          })),
        };
      },
    };
    const reports = await runChecks(broken, toSendConformance);
    expect(failed(reports)).toContain("send.partial");
  });

  it("fails an adapter that loses a recipient or calls a 5xx not_sent", async () => {
    const lossy: ProviderAdapter = {
      ...resendAdapter,
      async sendBatch(messages, credentials, ctx) {
        const result = await resendAdapter.sendBatch(messages, credentials, ctx);
        return { ...result, results: result.results.slice(1) };
      },
    };
    expect(failed(await runChecks(lossy, resendConformance))).toContain("send.all-sent");

    const overconfident: ProviderAdapter = {
      ...resendAdapter,
      async sendBatch(messages, credentials, ctx) {
        const result = await resendAdapter.sendBatch(messages, credentials, ctx);
        return {
          ...result,
          results: result.results.map((item) =>
            item.outcome === "unknown" ? { ...item, outcome: "not_sent" as const } : item,
          ),
        };
      },
    };
    expect(failed(await runChecks(overconfident, resendConformance))).toEqual(["send.uncertain"]);
  });

  it("fails a transactional-only adapter without a warning", async () => {
    const { policyWarning: _dropped, ...rest } = toSendAdapter;
    const reports = await runChecks(rest, toSendConformance);
    expect(failed(reports)).toEqual(["policy"]);
  });

  it("fails a missing fixture without a skip reason, and a skip of a required check", async () => {
    const { retryable: _retryable, ...send } = resendConformance.send;
    const reports = await runChecks(resendAdapter, {
      ...resendConformance,
      send,
      skip: { "send.headers": "We do not need it." },
    });
    expect(failed(reports)).toEqual(["send.headers", "send.retryable"]);
    const retry = status(reports, "send.retryable");
    expect(retry?.status === "fail" && retry.problems[0]).toContain(
      'fixtures.skip["send.retryable"]',
    );
  });
});
