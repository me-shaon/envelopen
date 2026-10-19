// Personalization CPU benchmark for a deployed Worker (KTD26, U8 test scenario
// "personalizing the default batch of 50 recipients fits the Free CPU budget").
//
// Local runs cannot measure Workers CPU time well: a laptop CPU differs from the edge,
// and workerd reports time in coarse steps. The local check is
// packages/email-render/src/personalize-bench.test.ts. Deploy this separate Worker to
// the account that runs Envelopen (ideally on the Free plan), then:
//
//   1. From the repository root:
//        npx wrangler deploy --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc
//   2. Send about 20 requests for each batch size, for example:
//        for n in 10 25 50 100; do
//          for i in $(seq 20); do curl -s "https://<worker-url>/?recipients=$n" >/dev/null; done
//        done
//      Add `&tracking=off` to measure a campaign with tracking off.
//   3. Read the CPU time per request: dashboard > Workers & Pages >
//      envelopen-personalize-benchmark > Logs (observability is on in its config), or
//      `npx wrangler tail --config apps/worker/scripts/personalize-benchmark/wrangler.jsonc --format json`
//      and look at cpuTime.
//   4. The batch of 50 passes when its p99 CPU time stays below about 5 ms. The
//      consumer also runs the claim, the send-time check, the provider call, and the
//      result writes in the same 10 ms Free budget (KTD20). If it does not pass, lower
//      the default batch size in packages/providers.
//   5. Delete the Worker: `npx wrangler delete --name envelopen-personalize-benchmark`.
//
// The signing key is a fixed test key: the Worker sends nothing and stores nothing.
import { createTokenSigner, personalize, prepareMessage } from "@envelopen/email-render";
import { sampleBatch, sampleEmail } from "@envelopen/email-render/bench";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
// Key derivation runs once per isolate, as in the consumer.
const signer = createTokenSigner([{ secret: KEY }]);
const html = sampleEmail();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const size = Number(url.searchParams.get("recipients") ?? "50");
    if (!Number.isInteger(size) || size < 1 || size > 500) {
      return new Response("recipients must be an integer from 1 to 500", { status: 400 });
    }
    const tracking = url.searchParams.get("tracking") !== "off";
    const prepared = prepareMessage({
      html,
      subject: "Week 3 for {{ first_name }}",
      trackingOrigin: "https://t.example.com",
      trackOpens: tracking,
      trackClicks: tracking,
    });
    const keys = await signer;
    let bytes = 0;
    for (const recipient of sampleBatch(size)) {
      bytes += (await personalize(prepared, recipient, keys)).html.length;
    }
    return Response.json({ recipients: size, tracking, templateBytes: html.length, bytes });
  },
};
