// PBKDF2 CPU benchmark for a deployed Worker (KTD7, U4 execution note).
//
// Local runs cannot measure Workers CPU time: workerd freezes the clock during compute,
// and a laptop CPU differs from the edge. Deploy this separate Worker to the account
// that runs Envelopen (ideally on the Free plan), then:
//
//   1. From the repository root:
//        npx wrangler deploy --config apps/worker/scripts/pbkdf2-benchmark/wrangler.jsonc
//   2. Send requests at several counts, about 20 each, for example:
//        for n in 10000 25000 50000 75000 100000; do
//          for i in $(seq 20); do curl -s "https://<worker-url>/?op=verify&iterations=$n" >/dev/null; done
//        done
//   3. Read the CPU time per request: dashboard > Workers & Pages >
//      envelopen-pbkdf2-benchmark > Logs (observability is on in its config). Current
//      Wrangler versions also print cpuTime per request with `npx wrangler tail --format json`.
//   4. Pick the largest count whose p99 CPU time stays below about 8 ms (the Free
//      limit is 10 ms per request, and a login also runs D1 queries and cookie
//      signing). Set PBKDF2_ITERATIONS in wrangler.jsonc to it. Below 100000, the
//      first-run screen enrolls a passkey instead of a password.
//   5. Probe the iteration cap: `curl "https://<worker-url>/cap"`. KTD7 expects
//      100000 to work and 100001 to fail on production Workers.
//   6. Delete the Worker: `npx wrangler delete --name envelopen-pbkdf2-benchmark`.
import { hashPassword, verifyPassword } from "../../src/auth/pbkdf2-hasher";

async function tryIterations(iterations: number): Promise<string> {
  try {
    await hashPassword("benchmark-password", iterations);
    return "ok";
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/cap") {
      return Response.json({
        "100000": await tryIterations(100_000),
        "100001": await tryIterations(100_001),
      });
    }
    const iterations = Number(url.searchParams.get("iterations") ?? "100000");
    if (!Number.isInteger(iterations) || iterations < 1) {
      return new Response("iterations must be a positive integer", { status: 400 });
    }
    // `hash` is what setup and recovery cost. `verify` is what a login costs.
    // The verify target is hashed outside the measured work: use a fixed salt and key.
    const op = url.searchParams.get("op") ?? "verify";
    if (op === "hash") {
      await hashPassword("benchmark-password", iterations);
    } else {
      const salt = "AAAAAAAAAAAAAAAAAAAAAA==";
      const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      await verifyPassword("benchmark-password", `$pbkdf2-sha256$i=${iterations}$${salt}$${key}`);
    }
    return Response.json({ op, iterations });
  },
};
