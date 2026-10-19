// A stand-in for the providers' send endpoints in tests. It accepts every message, in
// the response shape of each provider (the conformance fixtures), and records each
// call. `respond` lets a test answer a call itself, for example with a 429 or a timeout.
// Nothing leaves the test.

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** The recipients of the call, in order. */
  to: string[];
}

export interface ProviderMock {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Every recipient address that a provider accepted, in order. */
  delivered: string[];
  /** Answer a call before the default handler. Return undefined to fall through. */
  respond?: (call: RecordedCall, index: number) => Response | Promise<Response> | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type To = string | { email: string } | Array<string | { email: string }> | undefined;

function first(to: To): string {
  const value = Array.isArray(to) ? to[0] : to;
  return typeof value === "string" ? value : (value?.email ?? "");
}

function recipients(url: string, body: string): string[] {
  const parsed = JSON.parse(body || "null") as unknown;
  if (url.includes("amazonaws.com")) {
    const ses = parsed as { Destination?: { ToAddresses?: string[] } };
    return ses.Destination?.ToAddresses ?? [];
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item: { to?: To; To?: string }) => first(item.to ?? item.To));
  }
  const emails = (parsed as { emails?: { to?: To }[] })?.emails;
  if (Array.isArray(emails)) return emails.map((item) => first(item.to));
  const single = parsed as { to?: To };
  if (single?.to) return [first(single.to)];
  return [];
}

export function createProviderMock(): ProviderMock {
  let counter = 0;
  const mock: ProviderMock = {
    calls: [],
    delivered: [],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "GET" ? "" : await request.text();
      const call: RecordedCall = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
        to: body ? recipients(request.url, body) : [],
      };
      const index = mock.calls.length;
      mock.calls.push(call);
      const custom = await mock.respond?.(call, index);
      if (custom) return custom;
      const url = new URL(request.url);
      const id = () => `msg-${++counter}`;
      mock.delivered.push(...call.to);
      if (url.host === "api.resend.com" && url.pathname === "/emails/batch") {
        return json(200, { data: call.to.map(() => ({ id: id() })) });
      }
      if (url.host.endsWith("amazonaws.com") && url.pathname === "/v2/email/outbound-emails") {
        return json(200, { MessageId: id() });
      }
      if (url.host === "api.postmarkapp.com" && url.pathname === "/email/batch") {
        return json(
          200,
          call.to.map((to) => ({ ErrorCode: 0, Message: "OK", MessageID: id(), To: to })),
        );
      }
      if (url.host === "api.tosend.com" && url.pathname === "/v2/emails/batch") {
        return json(200, { results: call.to.map(() => ({ status: "success", message_id: id() })) });
      }
      if (url.host === "api.cloudflare.com" && url.pathname.endsWith("/email/sending/send")) {
        return json(200, {
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [], permanent_bounces: [], queued: call.to },
        });
      }
      mock.delivered.splice(mock.delivered.length - call.to.length, call.to.length);
      return json(404, { message: `No mock for ${request.method} ${request.url}` });
    },
  };
  return mock;
}
