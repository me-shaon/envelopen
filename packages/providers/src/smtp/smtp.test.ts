import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { brevoFixtures } from "../../conformance/fixtures/smtp";
import { mockSmtp } from "../../conformance/mock-smtp";
import { batchSizeFor } from "../index";
import type { AdapterContext } from "../types";
import { presetOf, smtpAdapter, smtpSettings } from "./index";
import { GMAIL_POLICY_WARNING, SMTP_PRESETS } from "./presets";

// The SMTP adapter (U18) against the in-process mock server. No test opens a socket.

function ctx(connect = mockSmtp().connect, refs = {}): AdapterContext {
  return {
    fetch: (() => Promise.reject(new Error("no HTTP"))) as unknown as typeof fetch,
    connect,
    refs,
    timeoutMs: 500,
  };
}

const GMAIL = { preset: "gmail", username: "ana@gmail.com", password: "abcd efgh ijkl mnop" };

describe("SMTP adapter", () => {
  it("connects with EHLO, STARTTLS, and AUTH, then QUIT, and sends nothing", async () => {
    const server = mockSmtp({ username: "ana@gmail.com", password: "abcdefghijklmnop" });
    const check = await smtpAdapter.connect(GMAIL, ctx(server.connect));
    expect(check).toEqual({
      ok: true,
      account: "ana@gmail.com on smtp.gmail.com:587",
      warnings: [expect.stringContaining("no bounce or complaint events")],
      refs: { preset: "gmail" },
    });
    const [session] = server.sessions;
    expect(session?.target).toEqual({
      hostname: "smtp.gmail.com",
      port: 587,
      secureTransport: "starttls",
    });
    expect(session?.commands.map((line) => line.split(" ")[0])).toEqual([
      "EHLO",
      "STARTTLS",
      "EHLO",
      "AUTH",
      "QUIT",
    ]);
    expect(server.messages).toHaveLength(0);
  });

  it("maps an auth failure on connect to auth, and tells Gmail users about app passwords", async () => {
    const server = mockSmtp({ username: "ana@gmail.com", password: "another-password" });
    const check = await smtpAdapter.connect(GMAIL, ctx(server.connect));
    expect(check).toMatchObject({ ok: false, reason: "auth" });
    expect(check.ok === false && check.message).toContain("535");
    expect(check.ok === false && check.message).toContain("app password");
    expect(check.ok === false && check.message).not.toContain("abcdefghijklmnop");

    const custom = await smtpAdapter.connect(
      { preset: "custom", host: "smtp.example.com", port: "465", username: "u", password: "x" },
      ctx(mockSmtp().connect),
    );
    expect(custom).toMatchObject({ ok: false, reason: "auth" });
    expect(custom.ok === false && custom.message).not.toContain("app password");
  });

  it("uses the preset's host, port, and TLS mode, and the owner's for custom SMTP", () => {
    expect(smtpSettings({ ...GMAIL, host: "evil.example.com", port: "25" })).toMatchObject({
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls",
      password: "abcdefghijklmnop",
    });
    expect(smtpSettings(brevoFixtures.credentials)).toMatchObject({
      preset: "brevo",
      host: "smtp-relay.brevo.com",
      port: 587,
    });
    expect(
      smtpSettings({
        preset: "custom",
        host: "Mail.Example.com",
        port: "465",
        username: "u",
        password: "p",
      }),
    ).toMatchObject({ host: "mail.example.com", port: 465, security: "tls" });
  });

  it("refuses port 25, a missing host, and a bad TLS mode as validation", async () => {
    const base = { preset: "custom", username: "u", password: "p" };
    for (const credentials of [
      { ...base, host: "smtp.example.com", port: "25" },
      { ...base, port: "587" },
      { ...base, host: "smtp.example.com", port: "587", security: "none" },
      { ...base, host: "bad host", port: "587" },
    ]) {
      const check = await smtpAdapter.connect(credentials, ctx());
      expect(check).toMatchObject({ ok: false, reason: "validation" });
    }
    const send = await smtpAdapter.sendBatch(
      campaignBatch(2),
      { ...base, host: "smtp.example.com", port: "25" },
      ctx(),
    );
    expect(send.failure).toMatchObject({ outcome: "not_sent", reason: "validation" });
    expect(send.results.map((item) => item.outcome)).toEqual(["not_sent", "not_sent"]);
  });

  it("fails without the socket capability, and sends nothing", async () => {
    const { connect: _none, ...noSockets } = ctx();
    const check = await smtpAdapter.connect(GMAIL, noSockets);
    expect(check).toMatchObject({ ok: false, reason: "network" });
  });

  it("derives the policy warning and the webhook from the preset", () => {
    expect(smtpAdapter.connectionPolicyWarning?.({ preset: "gmail" })).toBe(GMAIL_POLICY_WARNING);
    expect(smtpAdapter.connectionPolicyWarning?.({ preset: "workspace" })).toContain("2,000");
    expect(smtpAdapter.connectionPolicyWarning?.({ preset: "brevo" })).toBeNull();
    expect(smtpAdapter.connectionPolicyWarning?.({})).toBeNull();
    expect(smtpAdapter.connectionHasWebhook?.({ preset: "brevo" })).toBe(true);
    expect(smtpAdapter.connectionHasWebhook?.({ preset: "custom" })).toBe(false);
    expect(presetOf({ preset: "unknown" })).toBe("custom");
    expect(SMTP_PRESETS.map((preset) => [preset.id, preset.defaultDailyCap])).toEqual([
      ["gmail", 500],
      ["workspace", 2000],
      ["brevo", 300],
      ["custom", null],
    ]);
  });

  it("sends 20 messages per batch on Workers Free and 50 on Paid", () => {
    expect(batchSizeFor(smtpAdapter, "free")).toBe(20);
    expect(batchSizeFor(smtpAdapter, "paid")).toBe(50);
  });

  it("shows the Brevo steps without the token in the URL", () => {
    const steps = smtpAdapter.manualSteps({
      url: brevoFixtures.hookUrl,
      secret: brevoFixtures.token,
    });
    expect(steps.join("\n")).toContain('"auth":{"type":"bearer"');
    expect(steps.join("\n")).toContain(`"url":"${brevoFixtures.hookUrl}"`);
    expect(smtpAdapter.manualSteps({ url: "", secret: "" })[0]).toContain("no webhook");
  });
});
