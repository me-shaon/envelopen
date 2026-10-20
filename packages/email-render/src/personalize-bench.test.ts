import { describe, expect, it } from "vitest";
import { testKey } from "../test/keys";
import { sampleBatch, sampleEmail } from "./bench-fixtures";
import { personalize, prepareMessage } from "./personalize";
import { createTokenSigner } from "./tokens";

// Local CPU check of the KTD26 hot path: one batch of 50 recipients, as the queue
// consumer runs it, with a 40 KB template and 20 tracked links. workerd advances the
// clock during compute in local tests (at a coarse 1 ms step), so performance.now()
// measures the work here.
// The real Free-plan number comes from the deployed benchmark in
// apps/worker/scripts/personalize-benchmark. This test only catches a regression,
// for example a parse per recipient, so its bound is loose. Shared CI runners measure
// up to about 8 ms where a laptop measures under 1 ms; a parse per recipient costs far
// more than 20 ms.

const RUNS = 15;
const LOCAL_BUDGET_MS = 20;

describe("personalize benchmark", () => {
  it("personalizes the default batch of 50 well inside the Free CPU budget", async () => {
    const signer = await createTokenSigner([{ secret: testKey(4) }]);
    const html = sampleEmail();
    const batch = sampleBatch(50);
    const times: number[] = [];
    let bytes = 0;
    for (let run = 0; run < RUNS + 2; run++) {
      const start = performance.now();
      const prepared = prepareMessage({
        html,
        subject: "Week 3 for {{ first_name }}",
        trackingOrigin: "https://t.example.com",
        trackOpens: true,
        trackClicks: true,
      });
      const out = [];
      for (const recipient of batch) out.push(await personalize(prepared, recipient, signer));
      const elapsed = performance.now() - start;
      bytes = out.reduce((sum, message) => sum + message.html.length, 0);
      if (run >= 2) times.push(elapsed); // The first two runs warm up the JIT.
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] as number;
    console.log(
      `personalize: ${batch.length} recipients, ${(html.length / 1024).toFixed(0)} KB template, ` +
        `${(bytes / 1024 / 1024).toFixed(1)} MB out: median ${median.toFixed(2)} ms, ` +
        `max ${(times.at(-1) as number).toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(LOCAL_BUDGET_MS);
  });
});
