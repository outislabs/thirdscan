import { runPriceCycle } from "./ingest.js";
import { runOhlcvCycle } from "./ohlcv.js";
import { runDexscreenerCycle } from "./dexscreener.js";
import { runRegistrySeed } from "./registry.js";
import { CHAIN } from "./chain.js";

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");
const PRICE_INTERVAL_MS = 5 * 60 * 1000;
const OHLCV_INTERVAL_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// jupiter (price + token icons) and helius (holders) only cover solana, and
// the worker now runs robinhood chain only. their code is kept in
// jupiter.ts / helius.ts / holders.ts, unchanged and still pinned to
// 'solana', but none of it is called. re-enable by calling runJupiterCycle
// / runHoldersCycle again from a solana run.
function logPausedJobs(): void {
  console.log(
    `jupiter, helius holders: paused -- solana-only providers, worker is running chain=${CHAIN}`,
  );
}

async function main(): Promise<void> {
  // dry run exercises only the registry seed, read-only: every other job
  // writes, so none of them run.
  if (DRY_RUN) {
    await runRegistrySeed({ dryRun: true });
    return;
  }

  if (ONCE) {
    const discovered = await runPriceCycle();
    await runDexscreenerCycle(discovered.map((t) => t.address));
    await runRegistrySeed();
    await runOhlcvCycle();
    logPausedJobs();
    return;
  }

  // run continuously, waiting out the interval between cycle *completions*
  // so a slow cycle never overlaps with the next one. ohlcv runs on its
  // own, slower cadence, piggybacking on whichever price cycle crosses its
  // interval mark.
  let lastOhlcvAt = 0;
  logPausedJobs();

  for (;;) {
    const startedAt = Date.now();
    const discovered = await runPriceCycle();
    await runDexscreenerCycle(discovered.map((t) => t.address));
    await runRegistrySeed();

    if (startedAt - lastOhlcvAt >= OHLCV_INTERVAL_MS) {
      await runOhlcvCycle();
      lastOhlcvAt = Date.now();
    }

    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(PRICE_INTERVAL_MS - elapsed, 0);
    await sleep(remaining);
  }
}

main().catch((err) => {
  console.error("fatal error:", err);
  process.exit(1);
});
