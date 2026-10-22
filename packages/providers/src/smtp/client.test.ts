import { describe, expect, it } from "vitest";
import { campaignBatch, campaignMessage } from "../../conformance/fixtures/messages";
import { type MockSmtpOptions, mockSmtp, parseMail } from "../../conformance/mock-smtp";
import type { OutgoingMessage } from "../types";
import { checkSmtp, type SmtpSettings, sendSmtpBatch } from "./client";

// The SMTP client against the in-process mock server (KTD12). No test opens a socket.

const STARTTLS: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "user",
  password: "secret",
};
const IMPLICIT: SmtpSettings = { ...STARTTLS, port: 465, security: "tls" };
const NOW = Date.UTC(2026, 9, 22, 9, 30, 0);

function run(
  messages: readonly OutgoingMessage[],
  options: MockSmtpOptions = {},
  settings: SmtpSettings = STARTTLS,
  timeoutMs = 2_000,
) {
  const server = mockSmtp(options);
  const result = sendSmtpBatch(messages, settings, {
    connect: server.connect,
    timeoutMs,
    now: () => NOW,
  });
  return { server, result };
}

describe("SMTP client", () => {
  it("sends three messages on one connection with STARTTLS and AUTH PLAIN", async () => {
    const { server, result } = run(campaignBatch(3), { authMechanisms: ["PLAIN", "LOGIN"] });
    const { results, failure } = await result;
    expect(failure).toBeUndefined();
    expect(results.map((item) => item.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(server.sessions).toHaveLength(1);
    const [session] = server.sessions;
    expect(session?.target).toEqual({
      hostname: "smtp.example.com",
      port: 587,
      secureTransport: "starttls",
    });
    expect(session?.authOverPlaintext).toBe(false);
    const verbs = session?.commands.map((line) => line.split(" ")[0]);
    expect(verbs).toEqual([
      "EHLO",
      "STARTTLS",
      "EHLO",
      "AUTH",
      ...["MAIL", "RCPT", "DATA"],
      ...["RSET", "MAIL", "RCPT", "DATA"],
      ...["RSET", "MAIL", "RCPT", "DATA"],
      "QUIT",
    ]);
    expect(session?.commands[3]).toMatch(/^AUTH PLAIN /);
    expect(session?.closed).toBe(true);

    expect(server.messages).toHaveLength(3);
    const first = server.messages[0];
    expect(first?.secure).toBe(true);
    expect(first?.from).toBe("news@mail.example.com");
    expect(first?.to).toEqual(["student1@example.org"]);
    const mail = parseMail(first?.data ?? "");
    expect(mail.headers.get("from")).toBe("Course Academy <news@mail.example.com>");
    expect(mail.headers.get("to")).toBe("student1@example.org");
    expect(mail.headers.get("reply-to")).toBe("hello@example.com");
    expect(mail.headers.get("subject")).toBe("A new course starts Monday");
    expect(mail.headers.get("date")).toBe("Thu, 22 Oct 2026 09:30:00 +0000");
    expect(mail.headers.get("mime-version")).toBe("1.0");
    expect(mail.headers.get("list-unsubscribe")).toBe("<https://track.example.com/u/token1>");
    expect(mail.headers.get("list-unsubscribe-post")).toBe("List-Unsubscribe=One-Click");
    expect(mail.headers.get("content-type")).toMatch(/^multipart\/alternative; boundary="/);
    expect(mail.text).toBe("Hello student 1");
    expect(mail.html).toBe("<p>Hello student 1</p>");
    const messageId = mail.headers.get("message-id");
    expect(messageId).toMatch(/^<[0-9a-f]{32}@mail\.example\.com>$/);
    expect(results[0]?.providerMessageId).toBe(messageId);
  });

  it("uses AUTH LOGIN when the server does not offer PLAIN", async () => {
    const { server, result } = run(campaignBatch(1), { authMechanisms: ["LOGIN"] });
    expect((await result).results[0]?.outcome).toBe("sent");
    const commands = server.sessions[0]?.commands ?? [];
    expect(commands).toContain("AUTH LOGIN");
    expect(commands).toContain(btoa("user"));
    expect(commands).toContain(btoa("secret"));
  });

  it("uses implicit TLS on port 465 without STARTTLS", async () => {
    const { server, result } = run(campaignBatch(2), {}, IMPLICIT);
    expect((await result).results.map((item) => item.outcome)).toEqual(["sent", "sent"]);
    const [session] = server.sessions;
    expect(session?.target.secureTransport).toBe("on");
    expect(session?.commands).not.toContain("STARTTLS");
    expect(session?.authOverPlaintext).toBe(false);
  });

  it("falls back to HELO only when EHLO is rejected", async () => {
    const { server, result } = run(campaignBatch(1), { rejectEhlo: true }, IMPLICIT);
    const { results, failure } = await result;
    // HELO lists no extensions, so there is no AUTH mechanism, and nothing is sent.
    expect(failure?.reason).toBe("auth");
    expect(results[0]?.outcome).toBe("not_sent");
    expect(server.sessions[0]?.commands.slice(0, 2).map((line) => line.split(" ")[0])).toEqual([
      "EHLO",
      "HELO",
    ]);
  });

  it("dot-stuffs body lines that start with a dot", async () => {
    const message: OutgoingMessage = {
      ...campaignMessage(1),
      text: "Line one\n.hidden\n.\nLast",
      html: "<p>x</p>",
    };
    const { server, result } = run([message]);
    expect((await result).results[0]?.outcome).toBe("sent");
    const captured = server.messages[0];
    expect(captured?.wire).toContain("\r\n..hidden\r\n");
    expect(captured?.wire).toContain("\r\n..\r\n");
    expect(parseMail(captured?.data ?? "").text).toBe("Line one\r\n.hidden\r\n.\r\nLast");
  });

  it("normalizes every line ending to CRLF", async () => {
    const message: OutgoingMessage = {
      ...campaignMessage(1),
      text: "one\ntwo\rthree\r\nfour",
      html: "<p>a</p>\n<p>b</p>\r<p>c</p>",
    };
    const { server, result } = run([message]);
    expect((await result).results[0]?.outcome).toBe("sent");
    const data = server.messages[0]?.data ?? "";
    expect(data).not.toMatch(/\r(?!\n)/);
    expect(data).not.toMatch(/(?<!\r)\n/);
    const mail = parseMail(data);
    expect(mail.text).toBe("one\r\ntwo\r\nthree\r\nfour");
    expect(mail.html).toBe("<p>a</p>\r\n<p>b</p>\r\n<p>c</p>");
  });

  it("encodes a non-ASCII subject and from name per RFC 2047", async () => {
    const subject = "Grüße aus Köln: ein neuer Kurs beginnt am Montag ✓ und dauert drei Wochen";
    const message: OutgoingMessage = {
      ...campaignMessage(1),
      from: "Zoë Académie <news@mail.example.com>",
      subject,
      text: "Grüße",
      html: "<p>Grüße ✓</p>",
    };
    const { server, result } = run([message]);
    expect((await result).results[0]?.outcome).toBe("sent");
    const data = server.messages[0]?.data ?? "";
    // The header block is 7-bit ASCII, and every line is short.
    const head = data.slice(0, data.indexOf("\r\n\r\n"));
    expect(head).toMatch(/^[\x20-\x7e\r\n\t]*$/);
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/);
    const mail = parseMail(data);
    expect(mail.headers.get("subject")).toBe(subject);
    expect(mail.headers.get("from")).toBe("Zoë Académie <news@mail.example.com>");
    expect(mail.text).toBe("Grüße");
    expect(mail.html).toBe("<p>Grüße ✓</p>");
  });

  it("maps a 535 to auth and sends nothing", async () => {
    const { server, result } = run(campaignBatch(3), { password: "other" });
    const { results, failure } = await result;
    expect(failure).toMatchObject({ outcome: "not_sent", reason: "auth" });
    expect(results.every((item) => item.outcome === "not_sent" && item.reason === "auth")).toBe(
      true,
    );
    expect(server.messages).toHaveLength(0);
    expect(server.sessions[0]?.closed).toBe(true);
  });

  it("maps a 421 to unknown for the rest of the batch", async () => {
    const { server, result } = run(campaignBatch(3), {
      reply: (command) =>
        command.verb === "RCPT" && command.accepted === 1
          ? "421 4.7.0 Try again later, closing connection"
          : undefined,
    });
    const { results, failure } = await result;
    expect(results.map((item) => item.outcome)).toEqual(["sent", "unknown", "unknown"]);
    expect(failure).toMatchObject({ outcome: "unknown", reason: "server_error" });
    expect(server.messages).toHaveLength(1);
  });

  it("maps a read timeout to unknown for the rest of the batch", async () => {
    const { result } = run(
      campaignBatch(3),
      {
        reply: (command) =>
          command.verb === "DATA_END" && command.accepted === 1 ? "timeout" : undefined,
      },
      STARTTLS,
      100,
    );
    const { results, failure } = await result;
    expect(results.map((item) => item.outcome)).toEqual(["sent", "unknown", "unknown"]);
    expect(failure).toMatchObject({ outcome: "unknown", reason: "timeout" });
  });

  it("maps a disconnect to unknown for the rest of the batch", async () => {
    const { result } = run(campaignBatch(2), {
      reply: (command) => (command.verb === "DATA" ? "disconnect" : undefined),
    });
    const { results, failure } = await result;
    expect(results.map((item) => item.outcome)).toEqual(["unknown", "unknown"]);
    expect(failure).toMatchObject({ outcome: "unknown", reason: "network" });
  });

  it("maps a 550 quota reply to quota for the rest of the batch", async () => {
    const { server, result } = run(campaignBatch(3), {
      reply: (command) =>
        command.verb === "MAIL" && command.accepted === 2
          ? "550 5.4.5 Daily user sending quota exceeded"
          : undefined,
    });
    const { results, failure } = await result;
    expect(results.map((item) => item.outcome)).toEqual(["sent", "sent", "not_sent"]);
    expect(results[2]?.reason).toBe("quota");
    expect(failure).toMatchObject({ outcome: "not_sent", reason: "quota" });
    expect(server.messages).toHaveLength(2);
  });

  it("maps a 552 with the quota code 5.4.5 to quota (U19)", async () => {
    const { result } = run(campaignBatch(2), {
      reply: (command) =>
        command.verb === "RCPT" && command.accepted === 1
          ? "552 5.4.5 Try again tomorrow"
          : undefined,
    });
    const { results, failure } = await result;
    expect(results.map((item) => item.outcome)).toEqual(["sent", "not_sent"]);
    expect(failure).toMatchObject({ outcome: "not_sent", reason: "quota" });
  });

  it("maps a 451 to rate_limited", async () => {
    const { result } = run(campaignBatch(2), {
      reply: (command) =>
        command.verb === "RCPT" ? "451 4.7.1 Too many messages, slow down" : undefined,
    });
    const { results, failure } = await result;
    expect(results.map((item) => item.reason)).toEqual(["rate_limited", "rate_limited"]);
    expect(failure).toMatchObject({ outcome: "not_sent", reason: "rate_limited" });
  });

  it("maps a per-recipient 550 to not_sent for that recipient only", async () => {
    const { server, result } = run(campaignBatch(3), {
      reply: (command) =>
        command.verb === "RCPT" && command.arg.includes("student2@")
          ? "550 5.1.1 The email account does not exist"
          : undefined,
    });
    const { results, failure } = await result;
    expect(failure).toBeUndefined();
    expect(results.map((item) => item.outcome)).toEqual(["sent", "not_sent", "sent"]);
    expect(results[1]).toMatchObject({ reason: "rejected" });
    expect(results[1]?.message).toContain("550");
    expect(server.messages.map((item) => item.to[0])).toEqual([
      "student1@example.org",
      "student3@example.org",
    ]);
  });

  it("fails before AUTH when the server on 587 does not offer STARTTLS", async () => {
    const { server, result } = run(campaignBatch(2), { starttls: false, authBeforeTls: true });
    const { results, failure } = await result;
    expect(failure).toMatchObject({ outcome: "not_sent", reason: "auth" });
    expect(failure?.message).toMatch(/STARTTLS/);
    expect(results.every((item) => item.outcome === "not_sent")).toBe(true);
    const commands = server.sessions[0]?.commands ?? [];
    expect(commands.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(server.sessions[0]?.authOverPlaintext).toBe(false);
  });

  it.each([
    ["subject", { subject: "Hello\r\nBcc: victim@example.net" }],
    ["from name", { from: "Ana\nBcc: victim@example.net <news@mail.example.com>" }],
    ["recipient address", { to: "student@example.org\r\nRCPT TO:<victim@example.net>" }],
    ["reply-to", { replyTo: "a@example.com\rX: y" }],
    ["header value", { headers: { ...campaignMessage(1).headers, "X-Tag": "a\nb" } }],
  ])("rejects a line break in the %s", async (_, change) => {
    const bad: OutgoingMessage = { ...campaignMessage(1), ...change } as OutgoingMessage;
    const { server, result } = run([bad, campaignMessage(2)]);
    const { results } = await result;
    expect(results[0]).toMatchObject({ outcome: "not_sent", reason: "validation" });
    expect(results[1]?.outcome).toBe("sent");
    const wire = [
      ...server.sessions.flatMap((item) => item.commands),
      ...server.messages.map((m) => m.wire),
    ];
    expect(wire.join("\n")).not.toContain("victim");
  });

  it("does not connect when every message is invalid", async () => {
    const { server, result } = run([{ ...campaignMessage(1), to: "not an address" }]);
    expect((await result).results[0]).toMatchObject({ outcome: "not_sent", reason: "validation" });
    expect(server.sessions).toHaveLength(0);
  });

  it("keeps the credentials out of errors and results", async () => {
    const password = "hunter2-very-secret";
    const echo = btoa(`\0user\0${password}`);
    const { result } = run(
      campaignBatch(1),
      {
        password: "other",
        reply: (command) =>
          command.verb === "AUTH" ? `535 5.7.8 Bad credentials ${password} ${echo}` : undefined,
      },
      { ...STARTTLS, password },
    );
    const text = JSON.stringify(await result);
    expect(text).not.toContain(password);
    expect(text).not.toContain(echo);
    expect(text).toContain("[redacted]");

    const thrown = await sendSmtpBatch(
      campaignBatch(1),
      { ...STARTTLS, password },
      {
        connect: () => {
          throw new Error(`connect failed for ${password}`);
        },
      },
    );
    expect(JSON.stringify(thrown)).not.toContain(password);

    await expect(
      sendSmtpBatch(
        campaignBatch(1),
        { ...STARTTLS, host: "bad\r\nhost", password },
        {
          connect: mockSmtp().connect,
        },
      ),
    ).rejects.toSatisfy((error: unknown) => !String((error as Error).message).includes(password));
  });

  it("checks a connection without sending", async () => {
    const server = mockSmtp();
    expect(await checkSmtp(STARTTLS, { connect: server.connect })).toEqual({ ok: true });
    expect(server.sessions[0]?.commands.map((line) => line.split(" ")[0])).toEqual([
      "EHLO",
      "STARTTLS",
      "EHLO",
      "AUTH",
      "QUIT",
    ]);
    const wrong = mockSmtp({ password: "other" });
    expect(await checkSmtp(STARTTLS, { connect: wrong.connect })).toMatchObject({
      ok: false,
      reason: "auth",
    });
  });
});
