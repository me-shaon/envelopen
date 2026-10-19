// A DNS-over-HTTPS stand-in for tests: answers from a small zone in the JSON format of
// cloudflare-dns.com. Other requests go to `fallback`, for example a provider mock.

const TYPE_CODES: Record<string, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16 };

/** Keys are `TYPE name`, for example `TXT example.com`. TXT values are raw strings. */
export type Zone = Record<string, string[]>;

export interface DohMock {
  fetch: typeof fetch;
  queries: string[];
}

export function dohFetch(
  zone: Zone,
  options: { fail?: "status" | "network" | "servfail"; fallback?: typeof fetch } = {},
): DohMock {
  const queries: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "cloudflare-dns.com") {
      if (options.fallback) return options.fallback(input, init);
      throw new Error(`Unexpected request to ${url}`);
    }
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") ?? "";
    queries.push(`${type} ${name}`);
    if (options.fail === "network") throw new TypeError("Network connection lost.");
    if (options.fail === "status") return new Response("busy", { status: 503 });
    if (options.fail === "servfail") return Response.json({ Status: 2 });
    const values = zone[`${type} ${name}`];
    if (!values) return Response.json({ Status: 3 });
    return Response.json({
      Status: 0,
      Answer: values.map((value) => ({
        name,
        type: TYPE_CODES[type],
        TTL: 300,
        data: type === "TXT" ? `"${value}"` : `${value}.`,
      })),
    });
  };
  return { fetch: fetcher as typeof fetch, queries };
}
