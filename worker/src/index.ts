import { runPriceCycle } from "./ingest.js";
import { runOhlcvCycle } from "./ohlcv.js";
import { runDexscreenerCycle } from "./dexscreener.js";

const ONCE = process.argv.includes("--once");
const PRICE_INTERVAL_MS = 5 * 60 * 1000;
const OHLCV_INTERVAL_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (ONCE) {
    const discovered = await runPriceCycle();
    await runDexscreenerCycle(discovered.map((t) => t.address));
    await runOhlcvCycle(discovered);
    return;
  }

  // run continuously, waiting out the interval between cycle *completions*
  // so a slow cycle never overlaps with the next one. ohlcv runs on its own,
  // slower cadence, piggybacking on whichever price cycle crosses the 15-min mark.
  let lastOhlcvAt = 0;

  for (;;) {
    const startedAt = Date.now();
    const discovered = await runPriceCycle();
    await runDexscreenerCycle(discovered.map((t) => t.address));

    if (startedAt - lastOhlcvAt >= OHLCV_INTERVAL_MS) {
      await runOhlcvCycle(discovered);
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
