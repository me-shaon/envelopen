import { connect } from "cloudflare:sockets";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { campaignBatch } from "../../conformance/fixtures/messages";
import { mockSmtp } from "../../conformance/mock-smtp";
import type { ProviderSocket, SocketConnect } from "../types";
import { buildMessage, dotStuff, type SmtpSettings, sendSmtpBatch } from "./client";

// Trial 1 of U17 (local part): the time of a 50-message batch through the SMTP client.
// It runs only with SMTP_TRIAL set to the address of a running apps/web/e2e/smtp-mock.mjs:
//
//   node apps/web/e2e/smtp-mock.mjs 2525 &
//   SMTP_TRIAL=127.0.0.1:2525 corepack pnpm --filter @envelopen/providers vitest run trial
//
// The test runs in workerd, the runtime of `wrangler dev`. It reports the wall time of
// each batch, and the time of the client's own work (MIME building and dot-stuffing).

const address = (env as { SMTP_TRIAL?: string }).SMTP_TRIAL ?? "";
const SETTINGS: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "user",
  password: "secret",
};
const RUNS = 10;

/** A socket to the local TCP mock. TLS is simulated, as in apps/worker/src/sockets.ts. */
function tcpMock(): SocketConnect {
  const match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(address);
  if (!match) throw new Error("SMTP_TRIAL must be a localhost address with a port.");
  return () => {
    const socket = connect(
      { hostname: match[1] as string, port: Number(match[2]) },
      { secureTransport: "off", allowHalfOpen: false },
    );
    const plain: ProviderSocket = {
      readable: socket.readable,
      writable: socket.writable,
      closed: socket.closed,
      close: () => socket.close(),
      startTls: () => plain,
    };
    return plain;
  };
}

function summary(label: string, samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return `${label}: median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms (${samples.length} runs)`;
}

describe.skipIf(!address)("SMTP trial 1 (local)", () => {
  it("times a 50-message batch", async () => {
    const batch = campaignBatch(50);
    const compute: number[] = [];
    const inProcess: number[] = [];
    const tcp: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      let start = performance.now();
      for (const message of batch) dotStuff(buildMessage(message, Date.now()).data);
      compute.push(performance.now() - start);

      const server = mockSmtp();
      start = performance.now();
      const local = await sendSmtpBatch(batch, SETTINGS, { connect: server.connect });
      inProcess.push(performance.now() - start);
      expect(local.results.every((item) => item.outcome === "sent")).toBe(true);

      start = performance.now();
      const remote = await sendSmtpBatch(batch, SETTINGS, { connect: tcpMock() });
      tcp.push(performance.now() - start);
      expect(remote.results.every((item) => item.outcome === "sent")).toBe(true);
    }
    console.log(
      [
        summary("client compute, 50 messages", compute),
        summary("in-process mock, 50 messages", inProcess),
        summary("TCP mock, 50 messages", tcp),
      ].join("\n"),
    );
  });
});
