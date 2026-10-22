import { connect } from "cloudflare:sockets";
import type { ProviderSocket, SocketConnect } from "@envelopen/providers";

// Outbound TCP for SMTP adapters (KTD12). Adapters get it as `AdapterContext.connect`.
// The platform validates TLS certificates, and nothing here turns that off.

/**
 * The socket capability. For local development and the end-to-end tests only,
 * OUTBOUND_MOCK_SMTP (`host:port`) sends every SMTP connection to the local mock in
 * apps/web/e2e/smtp-mock.mjs instead. The mock speaks plain TCP, so TLS is simulated:
 * the socket opens without TLS, and `startTls()` keeps the same socket. It works only
 * with a localhost address, so a deployed Worker cannot be pointed at another server.
 */
export function socketConnect(env: Pick<Env, "OUTBOUND_MOCK_SMTP">): SocketConnect {
  const mock = env.OUTBOUND_MOCK_SMTP;
  if (!mock) {
    return (target) =>
      connect(
        { hostname: target.hostname, port: target.port },
        { secureTransport: target.secureTransport, allowHalfOpen: false },
      );
  }
  const match = /^(localhost|127\.0\.0\.1):(\d{1,5})$/.exec(mock);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65_535) {
    throw new Error("OUTBOUND_MOCK_SMTP must be a localhost address with a port.");
  }
  const hostname = match[1] as string;
  return () => {
    const socket = connect({ hostname, port }, { secureTransport: "off", allowHalfOpen: false });
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
