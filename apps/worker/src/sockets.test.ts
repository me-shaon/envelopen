import { describe, expect, it } from "vitest";
import { socketConnect } from "./sockets";

describe("socketConnect", () => {
  it("accepts the SMTP mock only on localhost", () => {
    expect(() => socketConnect({ OUTBOUND_MOCK_SMTP: "smtp.example.com:25" })).toThrow(
      "OUTBOUND_MOCK_SMTP must be a localhost address with a port.",
    );
    expect(() => socketConnect({ OUTBOUND_MOCK_SMTP: "127.0.0.1" })).toThrow();
    expect(() => socketConnect({ OUTBOUND_MOCK_SMTP: "127.0.0.1:2525" })).not.toThrow();
  });

  it("simulates TLS for the mock: startTls keeps the plain socket", async () => {
    const connect = socketConnect({ OUTBOUND_MOCK_SMTP: "127.0.0.1:2525" });
    const socket = connect({
      hostname: "smtp.example.com",
      port: 587,
      secureTransport: "starttls",
    });
    expect(socket.startTls()).toBe(socket);
    await socket.close().catch(() => {});
  });
});
