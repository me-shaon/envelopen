// A fetch mock that replays recorded provider exchanges. The adapter tests use it, and
// the conformance kit (U18) builds on it. No test reaches a real provider.

/** A recorded provider response. `timeout` and `network` simulate transport failures. */
export type RecordedResponse =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | "timeout"
  | "network";

/** One provider exchange: which request it answers, and the recorded response. */
export interface RecordedExchange {
  /** What the exchange shows, for example "batch with one invalid recipient". */
  label: string;
  method: string;
  /** A full URL, or a pattern for URLs with ids. */
  url: string | RegExp;
  response: RecordedResponse | ((request: CapturedRequest) => RecordedResponse);
  /** How many requests the exchange answers. Defaults to every matching request. */
  times?: number;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export interface FetchMock {
  fetch: typeof fetch;
  /** Every request, in order. */
  calls: CapturedRequest[];
}

function toResponse(recorded: Exclude<RecordedResponse, "timeout" | "network">): Response {
  const body =
    recorded.body === undefined
      ? null
      : typeof recorded.body === "string"
        ? recorded.body
        : JSON.stringify(recorded.body);
  const headers = new Headers(recorded.headers);
  if (body !== null && !headers.has("content-type") && typeof recorded.body !== "string") {
    headers.set("content-type", "application/json");
  }
  return new Response(body, { status: recorded.status, headers });
}

/** A fetch that answers with the first exchange that matches each request. */
export function mockFetch(exchanges: readonly RecordedExchange[]): FetchMock {
  const remaining = exchanges.map((exchange) => ({ exchange, left: exchange.times ?? Infinity }));
  const calls: CapturedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const captured: CapturedRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body ? new TextDecoder().decode(await request.arrayBuffer()) : "",
    };
    calls.push(captured);
    const match = remaining.find(
      (item) =>
        item.left > 0 &&
        item.exchange.method.toUpperCase() === captured.method &&
        (typeof item.exchange.url === "string"
          ? item.exchange.url === captured.url
          : item.exchange.url.test(captured.url)),
    );
    if (!match) throw new Error(`No recorded exchange for ${captured.method} ${captured.url}`);
    match.left -= 1;
    const recorded =
      typeof match.exchange.response === "function"
        ? match.exchange.response(captured)
        : match.exchange.response;
    if (recorded === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (recorded === "network") throw new TypeError("Network connection lost.");
    return toResponse(recorded);
  };
  return { fetch: fetcher as typeof fetch, calls };
}
