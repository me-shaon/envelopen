import { bytesToBase64, bytesToHex, utf8 } from "../shared/encoding";
import type {
  BatchFailure,
  FailureReason,
  OutgoingMessage,
  ProviderSocket,
  RecipientResult,
  SendBatchResult,
  SocketConnect,
} from "../types";

// A small SMTP submission client on the `connect` capability (KTD12). It is a
// reply-per-command state machine: it writes one command, reads one reply, and decides.
// worker-mailer (MIT) was a reference. It is not a dependency.
//
// One batch is one connection: the greeting, EHLO, STARTTLS (port 587) or implicit TLS
// (port 465), AUTH, then MAIL FROM, RCPT TO, and DATA per message, with RSET between
// messages, and QUIT. Every read has a timeout, and the socket closes in `finally`.
//
// Security rules:
// - AUTH runs only on a TLS connection: implicit TLS, or a completed STARTTLS. The
//   client never falls back to plain text. The platform validates the certificate.
// - Addresses, names, the subject, and header values with CR or LF are refused before
//   any byte goes out, so a message cannot add commands or headers.
// - Header values with non-ASCII characters are RFC 2047 encoded words. The body is
//   UTF-8 quoted-printable with CRLF line endings, and it is dot-stuffed.
// - Errors and results never hold the credentials: the client redacts them from every
//   server reply that it reports.
//
// Reply mapping (see `classify`):
// - 530, 534, 535, 538, and a missing STARTTLS or AUTH mechanism: `auth`, nothing sent.
// - 421, a read timeout, a disconnect, or an unexpected reply: `unknown` for the message
//   in flight and every message after it. The message in flight may have gone out.
// - Quota wording ("quota", "daily ... limit", "limit exceeded") on a 4xx or 5xx: `quota`.
//   Rate wording ("rate", "too many", "throttl", "slow down") on a 5xx, and every other
//   451 or 452: `rate_limited`. Both stop the batch, and the rest is `not_sent`.
// - A 4.2.2 or 5.2.2 (the recipient's mailbox is full), and any other 4xx or 5xx on
//   MAIL FROM, RCPT TO, or DATA: `not_sent` for that recipient only, then RSET.

export type SmtpSecurity = "starttls" | "tls";

export interface SmtpSettings {
  host: string;
  port: number;
  /** `starttls` upgrades a plain connection (port 587). `tls` is implicit TLS (port 465). */
  security: SmtpSecurity;
  /** Empty for a relay that needs no AUTH. */
  username: string;
  password: string;
  /** The name in EHLO. Defaults to the domain of the first From address. */
  heloName?: string;
}

export interface SmtpContext {
  connect: SocketConnect;
  /** The longest wait for one reply, in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Clock for the Date header. Defaults to `Date.now`. */
  now?: () => number;
}

export type SmtpCheck = { ok: true } | { ok: false; reason: FailureReason; message: string };

export const DEFAULT_SMTP_TIMEOUT_MS = 15_000;
/** The final dot of DATA waits longer: the server may scan the message first. */
const DATA_END_FACTOR = 2;
const MAX_LINE = 4096;
const MAX_REPLY_LINES = 100;
const REDACTED = "[redacted]";

interface Reply {
  code: number;
  lines: string[];
}

type Stage = "greeting" | "ehlo" | "starttls" | "auth" | "mail" | "rcpt" | "data" | "data_end";

/** A failure that ends the batch. `outcome` and `reason` go to every message left. */
class BatchStop extends Error {
  constructor(
    readonly outcome: "not_sent" | "unknown",
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
  }
}

/** A refusal of one message. The batch goes on with the next one after RSET. */
class MessageRefused extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------
// Validation and MIME

const LINE_BREAK = /[\r\n]/;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const HEADER_NAME = /^[!-9;-~]+$/;
/** Headers that the client writes itself. A message cannot set them in `headers`. */
const OWN_HEADERS = new Set([
  "message-id",
  "date",
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

class Invalid extends Error {}

interface Mailbox {
  name: string;
  address: string;
}

function checkAddress(address: string, field: string): string {
  if (LINE_BREAK.test(address)) throw new Invalid(`The ${field} has a line break.`);
  if (address.length > 254 || !ADDRESS.test(address)) {
    throw new Invalid(`The ${field} is not a valid address.`);
  }
  return address;
}

/** Parses `Name <address>` or a bare address. */
function parseMailbox(value: string, field: string): Mailbox {
  if (LINE_BREAK.test(value)) throw new Invalid(`The ${field} has a line break.`);
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value.trim());
  if (!match) return { name: "", address: checkAddress(value.trim(), field) };
  let name = (match[1] ?? "").trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return { name, address: checkAddress(match[2] ?? "", field) };
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
/** Encoded words carry at most 45 bytes, so each stays within 75 characters. */
const WORD_BYTES = 45;

/** RFC 2047 B encoded words, split on character boundaries and folded. */
function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const char of value) {
    const bytes = utf8(char).length;
    if (size + bytes > WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${bytesToBase64(utf8(word))}?=`).join("\r\n ");
}

/** Folds an ASCII value at spaces, so lines stay near 78 characters. */
function foldAscii(name: string, value: string): string {
  const words = value.split(" ");
  let line = `${name}:`;
  const lines: string[] = [];
  for (const word of words) {
    if (line.length + 1 + word.length > 78 && line.trim() !== `${name}:`) {
      lines.push(line);
      line = "";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines.join("\r\n");
}

/** An unstructured header field, encoded when it needs it. */
function headerLine(name: string, value: string): string {
  if (!ASCII_PRINTABLE.test(value)) return `${name}: ${encodeWords(value)}`;
  const line = foldAscii(name, value);
  if (line.split("\r\n").some((part) => part.length > 998)) {
    throw new Invalid(`The ${name} header is too long.`);
  }
  return line;
}

function formatMailbox(mailbox: Mailbox): string {
  const { name, address } = mailbox;
  if (!name) return address;
  if (!ASCII_PRINTABLE.test(name)) return `${encodeWords(name)} <${address}>`;
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

/** Turns CR, LF, and CRLF into CRLF. */
function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

const HEX = "0123456789ABCDEF";

/** UTF-8 quoted-printable (RFC 2045) with CRLF line breaks and 76-character lines. */
export function quotedPrintable(text: string): string {
  return toCrlf(text)
    .split("\r\n")
    .map((line) => {
      const bytes = utf8(line);
      let out = "";
      let length = 0;
      bytes.forEach((byte, index) => {
        const last = index === bytes.length - 1;
        const plain =
          (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
        const token = plain
          ? String.fromCharCode(byte)
          : `=${HEX[byte >> 4] as string}${HEX[byte & 15] as string}`;
        if (length + token.length > 75) {
          out += "=\r\n";
          length = 0;
        }
        out += token;
        length += token.length;
      });
      return out;
    })
    .join("\r\n");
}

/** Adds a dot to each line that starts with one, and the end-of-data line (RFC 5321). */
export function dotStuff(data: string): string {
  return `${data
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n")}\r\n.\r\n`;
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The RFC 5322 date, for example `Thu, 22 Oct 2026 09:30:00 +0000`. */
function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

interface Prepared {
  from: string;
  to: string;
  messageId: string;
  data: string;
}

/** Validates one message and builds its MIME source. Throws `Invalid`. */
export function buildMessage(message: OutgoingMessage, now: number): Prepared {
  const from = parseMailbox(message.from, "from address");
  const to = parseMailbox(message.to, "recipient address");
  const replyTo =
    message.replyTo === undefined ? null : parseMailbox(message.replyTo, "reply-to address");
  if (LINE_BREAK.test(message.subject)) throw new Invalid("The subject has a line break.");
  const domain = from.address.slice(from.address.indexOf("@") + 1);
  const messageId = `<${randomHex(16)}@${domain}>`;

  const head = [
    `Message-ID: ${messageId}`,
    `Date: ${rfc5322Date(now)}`,
    `From: ${formatMailbox(from)}`,
    `To: ${formatMailbox(to)}`,
  ];
  if (replyTo) head.push(`Reply-To: ${formatMailbox(replyTo)}`);
  head.push(headerLine("Subject", message.subject), "MIME-Version: 1.0");
  for (const [name, value] of Object.entries(message.headers)) {
    if (!HEADER_NAME.test(name))
      throw new Invalid(`The header name ${JSON.stringify(name)} is not valid.`);
    if (LINE_BREAK.test(value)) throw new Invalid(`The ${name} header has a line break.`);
    if (OWN_HEADERS.has(name.toLowerCase())) {
      throw new Invalid(`The ${name} header is set by the SMTP client.`);
    }
    head.push(headerLine(name, value));
  }

  const part = (type: string, body: string) =>
    [
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(body),
    ].join("\r\n");

  let body: string;
  if (message.text === undefined) {
    const html = part("text/html", message.html);
    const split = html.indexOf("\r\n\r\n");
    head.push(html.slice(0, split));
    body = html.slice(split + 4);
  } else {
    // "=_" never appears in quoted-printable output, so the boundary is safe.
    const boundary = `=_envelopen_${randomHex(12)}`;
    head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      part("text/plain", message.text),
      `--${boundary}`,
      part("text/html", message.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return {
    from: from.address,
    to: to.address,
    messageId,
    data: `${head.join("\r\n")}\r\n\r\n${body}`,
  };
}

// ---------------------------------------------------------------------------------
// The session

function checkSettings(settings: SmtpSettings): void {
  if (!/^[A-Za-z0-9.-]+$/.test(settings.host)) throw new Error("The SMTP host is not valid.");
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) {
    throw new Error("The SMTP port is not valid.");
  }
  if (settings.security !== "starttls" && settings.security !== "tls") {
    throw new Error("The SMTP security setting is not valid.");
  }
  if (settings.heloName !== undefined && !/^[A-Za-z0-9.-]+$/.test(settings.heloName)) {
    throw new Error("The EHLO name is not valid.");
  }
}

/** Replaces the credentials, and their base64 forms, in text that the client reports. */
function redactor(settings: SmtpSettings): (text: string) => string {
  const secrets = new Set<string>();
  const add = (value: string) => {
    if (value.length >= 3) secrets.add(value);
  };
  if (settings.password) {
    add(settings.password);
    add(bytesToBase64(utf8(settings.password)));
    add(bytesToBase64(utf8(`\0${settings.username}\0${settings.password}`)));
  }
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => sorted.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

function describe(reply: Reply): string {
  const text = reply.lines.join(" ").trim();
  return `SMTP ${reply.code}${text ? ` ${text}` : ""}`.slice(0, 300);
}

const QUOTA_WORDING = /quota|daily .*limit|sending limit|limit exceeded|exceeded .*limit/i;
const RATE_WORDING = /rate|too many|throttl|slow down/i;
const MAILBOX_FULL = /\b[45]\.2\.2\b/;
const AUTH_CODES = new Set([530, 534, 535, 538]);

/** Turns a reply that is not the expected one into a batch stop or a message refusal. */
function classify(reply: Reply, stage: Stage): BatchStop | MessageRefused {
  const message = describe(reply);
  const { code } = reply;
  const text = reply.lines.join(" ");
  if (code === 421) return new BatchStop("unknown", "server_error", message);
  if (AUTH_CODES.has(code)) return new BatchStop("not_sent", "auth", message);
  const perMessage =
    stage === "mail" || stage === "rcpt" || stage === "data" || stage === "data_end";
  if (code >= 400 && code < 600) {
    if (perMessage && MAILBOX_FULL.test(text)) return new MessageRefused("rejected", message);
    if (QUOTA_WORDING.test(text)) return new BatchStop("not_sent", "quota", message);
    if (code >= 500 && RATE_WORDING.test(text))
      return new BatchStop("not_sent", "rate_limited", message);
    if (code === 451 || code === 452) return new BatchStop("not_sent", "rate_limited", message);
    if (perMessage) return new MessageRefused("rejected", message);
    if (stage === "auth") return new BatchStop("not_sent", "auth", message);
    return new BatchStop("not_sent", "rejected", message);
  }
  // A success code where another one belongs: the session is out of step.
  return new BatchStop("unknown", "server_error", `Unexpected reply: ${message}`);
}

class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  secure: boolean;
  extensions = new Map<string, string>();

  private constructor(
    private socket: ProviderSocket,
    private readonly timeoutMs: number,
    secure: boolean,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.secure = secure;
  }

  static open(settings: SmtpSettings, ctx: SmtpContext): Session {
    let socket: ProviderSocket;
    try {
      socket = ctx.connect({
        hostname: settings.host,
        port: settings.port,
        secureTransport: settings.security === "tls" ? "on" : "starttls",
      });
    } catch {
      throw new BatchStop("unknown", "network", "The connection to the SMTP server failed.");
    }
    return new Session(
      socket,
      ctx.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS,
      settings.security === "tls",
    );
  }

  /** Races a step against the timeout. */
  private async timed<T>(step: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new BatchStop("unknown", "timeout", "The SMTP server did not answer in time.")),
        ms,
      );
    });
    // The step may settle after the timeout. Its rejection must not go unhandled.
    step.catch(() => {});
    try {
      return await Promise.race([step, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLine(ms: number): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        return line;
      }
      if (this.buffer.length > MAX_LINE) {
        throw new BatchStop(
          "unknown",
          "server_error",
          "The SMTP server sent a line that is too long.",
        );
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.timed(this.reader.read(), ms);
      } catch (error) {
        if (error instanceof BatchStop) throw error;
        throw new BatchStop("unknown", "network", "The SMTP connection failed.");
      }
      if (chunk.done)
        throw new BatchStop("unknown", "network", "The SMTP server closed the connection.");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Reads one reply, with its continuation lines (`250-...`, then `250 ...`). */
  async read(ms = this.timeoutMs): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine(ms);
      const match = /^([2-5]\d\d)([ -]?)(.*)$/.exec(line);
      if (!match)
        throw new BatchStop(
          "unknown",
          "server_error",
          "The SMTP server sent a reply that is not valid.",
        );
      lines.push(match[3] ?? "");
      if (match[2] !== "-") return { code: Number(match[1]), lines };
      if (lines.length > MAX_REPLY_LINES) {
        throw new BatchStop("unknown", "server_error", "The SMTP reply is too long.");
      }
    }
  }

  async write(text: string): Promise<void> {
    try {
      await this.timed(this.writer.write(utf8(text)), this.timeoutMs);
    } catch (error) {
      if (error instanceof BatchStop) throw error;
      throw new BatchStop("unknown", "network", "The SMTP connection failed.");
    }
  }

  /** Writes one command and reads its reply. */
  async command(line: string, ms?: number): Promise<Reply> {
    await this.write(`${line}\r\n`);
    return this.read(ms);
  }

  /** Writes one command and throws unless the reply has one of the codes. */
  async expect(line: string, codes: readonly number[], stage: Stage, ms?: number): Promise<Reply> {
    const reply = await this.command(line, ms);
    if (!codes.includes(reply.code)) throw classify(reply, stage);
    return reply;
  }

  async greeting(): Promise<void> {
    const reply = await this.read();
    if (reply.code !== 220) throw classify(reply, "greeting");
  }

  async hello(name: string): Promise<void> {
    const reply = await this.command(`EHLO ${name}`);
    this.extensions.clear();
    if (reply.code === 250) {
      for (const line of reply.lines.slice(1)) {
        const [keyword = "", ...rest] = line.trim().split(/[ =]/);
        this.extensions.set(keyword.toUpperCase(), rest.join(" ").toUpperCase());
      }
      return;
    }
    if (reply.code < 500 || reply.code === 421) throw classify(reply, "ehlo");
    // Only a server that rejects EHLO gets HELO. HELO has no extensions.
    await this.expect(`HELO ${name}`, [250], "ehlo");
  }

  /** STARTTLS, then the socket from `startTls()` replaces the plain one. */
  async startTls(): Promise<void> {
    const reply = await this.command("STARTTLS");
    if (reply.code !== 220)
      throw new BatchStop("not_sent", "auth", `STARTTLS failed: ${describe(reply)}`);
    // Bytes after the 220 came before the handshake: a command injection. Stop here.
    if (this.buffer.length > 0) {
      throw new BatchStop(
        "unknown",
        "server_error",
        "The SMTP server sent data before the TLS handshake.",
      );
    }
    this.reader.releaseLock();
    this.writer.releaseLock();
    try {
      this.socket = this.socket.startTls();
    } catch {
      throw new BatchStop("not_sent", "network", "The TLS handshake with the SMTP server failed.");
    }
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.secure = true;
  }

  async auth(username: string, password: string): Promise<void> {
    if (!this.secure) {
      throw new BatchStop(
        "not_sent",
        "auth",
        "The connection is not encrypted, so Envelopen did not send the password.",
      );
    }
    const offered = this.extensions.get("AUTH")?.split(/\s+/) ?? [];
    if (offered.includes("PLAIN")) {
      const token = bytesToBase64(utf8(`\0${username}\0${password}`));
      const reply = await this.command(`AUTH PLAIN ${token}`);
      if (reply.code === 235) return;
      if (reply.code === 334) {
        await this.expect(token, [235], "auth");
        return;
      }
      throw classify(reply, "auth");
    }
    if (offered.includes("LOGIN")) {
      await this.expect("AUTH LOGIN", [334], "auth");
      await this.expect(bytesToBase64(utf8(username)), [334], "auth");
      await this.expect(bytesToBase64(utf8(password)), [235], "auth");
      return;
    }
    throw new BatchStop(
      "not_sent",
      "auth",
      "The SMTP server offers no AUTH mechanism that Envelopen supports (PLAIN or LOGIN).",
    );
  }

  /** RSET between messages. A refusal here means the session is out of step. */
  async reset(): Promise<void> {
    const reply = await this.command("RSET");
    if (reply.code === 250) return;
    const stop = classify(reply, "greeting");
    throw stop instanceof BatchStop && stop.outcome === "not_sent" && stop.reason !== "rejected"
      ? stop
      : new BatchStop("unknown", "server_error", `RSET failed: ${describe(reply)}`);
  }

  /** QUIT, best effort: the batch result does not depend on it. */
  async quit(): Promise<void> {
    try {
      await this.write("QUIT\r\n");
      await this.read(Math.min(this.timeoutMs, 2_000));
    } catch {
      // The server may close first.
    }
  }

  async close(): Promise<void> {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {
      // A pending read keeps the lock. close() ends it.
    }
    try {
      await this.timed(this.socket.close(), 1_000);
    } catch {
      // Closing is best effort.
    }
  }
}

/** Greeting, EHLO, STARTTLS, and AUTH. */
async function establish(
  session: Session,
  settings: SmtpSettings,
  heloName: string,
): Promise<void> {
  await session.greeting();
  await session.hello(heloName);
  if (settings.security === "starttls") {
    if (!session.extensions.has("STARTTLS")) {
      throw new BatchStop(
        "not_sent",
        "auth",
        "The SMTP server does not offer STARTTLS, so Envelopen did not send the password.",
      );
    }
    await session.startTls();
    await session.hello(heloName);
  }
  if (settings.username || settings.password)
    await session.auth(settings.username, settings.password);
}

function heloOf(settings: SmtpSettings, messages: readonly OutgoingMessage[]): string {
  if (settings.heloName) return settings.heloName;
  const from = messages[0]?.from ?? "";
  const domain = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from)?.[1];
  return domain ?? "localhost";
}

/**
 * Sends a batch on one connection. One result per message, in order. It never throws
 * for server or network errors. It throws only for settings that are not valid.
 */
export async function sendSmtpBatch(
  messages: readonly OutgoingMessage[],
  settings: SmtpSettings,
  ctx: SmtpContext,
): Promise<SendBatchResult> {
  checkSettings(settings);
  const redact = redactor(settings);
  const now = (ctx.now ?? Date.now)();
  const results: (RecipientResult | null)[] = messages.map(() => null);
  const prepared: (Prepared | null)[] = messages.map((message, index) => {
    try {
      return buildMessage(message, now);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      results[index] = {
        recipientId: message.recipientId,
        outcome: "not_sent",
        reason: "validation",
        message: error.message,
      };
      return null;
    }
  });

  let failure: BatchFailure | undefined;
  if (prepared.some((item) => item !== null)) {
    let session: Session | null = null;
    try {
      session = Session.open(settings, ctx);
      await establish(session, settings, heloOf(settings, messages));
      let first = true;
      for (const [index, item] of prepared.entries()) {
        if (!item) continue;
        const recipientId = (messages[index] as OutgoingMessage).recipientId;
        if (!first) await session.reset();
        first = false;
        try {
          await session.expect(`MAIL FROM:<${item.from}>`, [250], "mail");
          await session.expect(`RCPT TO:<${item.to}>`, [250, 251], "rcpt");
          await session.expect("DATA", [354], "data");
          await session.write(dotStuff(item.data));
          const reply = await session.read(
            (ctx.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS) * DATA_END_FACTOR,
          );
          if (reply.code !== 250) throw classify(reply, "data_end");
          results[index] = { recipientId, outcome: "sent", providerMessageId: item.messageId };
        } catch (error) {
          if (!(error instanceof MessageRefused)) throw error;
          results[index] = {
            recipientId,
            outcome: "not_sent",
            reason: error.reason,
            message: redact(error.message),
          };
        }
      }
      await session.quit();
    } catch (error) {
      const stop =
        error instanceof BatchStop
          ? error
          : new BatchStop("unknown", "network", "The SMTP session failed.");
      failure = { outcome: stop.outcome, reason: stop.reason, message: redact(stop.message) };
    } finally {
      await session?.close();
    }
  }

  return {
    results: results.map(
      (item, index) =>
        item ?? {
          recipientId: (messages[index] as OutgoingMessage).recipientId,
          outcome: failure?.outcome ?? "unknown",
          reason: failure?.reason ?? "network",
          message: failure?.message ?? "The SMTP session ended early.",
        },
    ),
    ...(failure ? { failure } : {}),
  };
}

/** Checks the settings: the greeting, TLS, and AUTH, then QUIT. It sends no message. */
export async function checkSmtp(settings: SmtpSettings, ctx: SmtpContext): Promise<SmtpCheck> {
  checkSettings(settings);
  const redact = redactor(settings);
  let session: Session | null = null;
  try {
    session = Session.open(settings, ctx);
    await establish(session, settings, settings.heloName ?? "localhost");
    await session.quit();
    return { ok: true };
  } catch (error) {
    const stop =
      error instanceof BatchStop || error instanceof MessageRefused
        ? error
        : new BatchStop("unknown", "network", "The SMTP session failed.");
    return { ok: false, reason: stop.reason, message: redact(stop.message) };
  } finally {
    await session?.close();
  }
}
