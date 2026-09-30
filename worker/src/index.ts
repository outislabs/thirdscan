import { runPriceCycle } from "./ingest.js";
import { runOhlcvCycle } from "./ohlcv.js";
import { runDexscreenerCycle } from "./dexscreener.js";
import { runRegistrySeed } from "./registry.js";
import { CHAIN } from "./chain.js";
import { supabase } from "./supabase.js";
import { JUPITER_WORKER_NAME } from "./jupiter.js";
import { HOLDERS_WORKER_NAME } from "./holders.js";

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
const PAUSED_MESSAGE = `paused -- solana-only provider, worker is running chain=${CHAIN}`;

/**
 * Logs the paused jobs and records it on their worker_status rows so a
 * status page shows "paused" instead of a silently stale last run. only
 * last_error is written: last_run_at stays at the last real (solana) run,
 * since these jobs haven't run since.
 */
async function markPausedJobs(): Promise<void> {
  console.log(`jupiter, helius holders: ${PAUSED_MESSAGE}`);
  const { error } = await supabase
    .from("worker_status")
    .update({ last_error: PAUSED_MESSAGE })
    .in("worker_name", [JUPITER_WORKER_NAME, HOLDERS_WORKER_NAME]);
  if (error) {
    console.error(`failed to mark paused jobs in worker_status: ${error.message}`);
  }
}

/**
 * Discovered tokens plus every registry mint with a tokens row, deduped.
 * registry mints mostly aren't in the top pools, so without this they'd
 * never get a price (jupiter used to cover them; it's paused).
 */
function dexscreenerAddresses(discovered: { address: string }[], registry: string[]): string[] {
  return [...new Set([...discovered.map((t) => t.address), ...registry])];
}

async function main(): Promise<void> {
  // dry run exercises only the registry seed, read-only: every other job
  // writes, so none of them run.
  if (DRY_RUN) {
    await runRegistrySeed({ dryRun: true });
    return;
  }

  if (ONCE) {
    await markPausedJobs();
    const discovered = await runPriceCycle();
    const registry = await runRegistrySeed();
    await runDexscreenerCycle(dexscreenerAddresses(discovered, registry));
    await runOhlcvCycle();
    return;
  }

  // run continuously, waiting out the interval between cycle *completions*
  // so a slow cycle never overlaps with the next one. ohlcv runs on its
  // own, slower cadence, piggybacking on whichever price cycle crosses its
  // interval mark.
  let lastOhlcvAt = 0;
  await markPausedJobs();

  for (;;) {
    const startedAt = Date.now();
    const discovered = await runPriceCycle();
    const registry = await runRegistrySeed();
    await runDexscreenerCycle(dexscreenerAddresses(discovered, registry));

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
