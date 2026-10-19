import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/types";
import { conformanceChecks } from "./checks";
import type { ConformanceFixtures } from "./fixtures/types";

// The adapter conformance kit (KTD15, U18) as a Vitest suite. Call it from a test file
// next to the adapter:
//
//   runConformance(myAdapter, myConformance);
//
// A check that does not apply shows as skipped, with the reason in its name.

export type { CheckReport, CheckStatus, ConformanceCheck } from "./checks";
export { conformanceChecks, runChecks } from "./checks";
export type * from "./fixtures/types";

export function runConformance(adapter: ProviderAdapter, fixtures: ConformanceFixtures): void {
  describe(`${adapter.name} (${adapter.id}) conformance`, () => {
    for (const check of conformanceChecks(adapter, fixtures)) {
      if (check.skip) {
        it.skip(`${check.id}: ${check.title} [skipped: ${check.skip}]`, () => {});
        continue;
      }
      it(`${check.id}: ${check.title}`, async () => {
        const result = await check.run();
        if (result.status === "fail") expect.fail(result.problems.join("\n"));
        expect(result.status).toBe("pass");
      });
    }
  });
}
