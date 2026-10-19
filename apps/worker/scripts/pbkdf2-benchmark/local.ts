// Rough local estimate of PBKDF2-SHA256 time with Node's WebCrypto. It is NOT the
// Workers CPU time: run the deployed benchmark in this folder for the real number.
//
//   npx tsx apps/worker/scripts/pbkdf2-benchmark/local.ts
import { hashPassword } from "../../src/auth/pbkdf2-hasher";

const RUNS = 10;
for (const iterations of [10_000, 25_000, 50_000, 75_000, 100_000]) {
  await hashPassword("warm-up", iterations);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await hashPassword("benchmark-password", iterations);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(RUNS / 2)] ?? 0;
  const max = times[RUNS - 1] ?? 0;
  console.log(`${iterations} iterations: median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
}
