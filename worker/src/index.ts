import { runCycle } from "./ingest.js";

const ONCE = process.argv.includes("--once");
const INTERVAL_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (ONCE) {
    await runCycle();
    return;
  }

  // run continuously, waiting out the interval between cycle *completions*
  // so a slow cycle never overlaps with the next one.
  for (;;) {
    const startedAt = Date.now();
    await runCycle();
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(INTERVAL_MS - elapsed, 0);
    await sleep(remaining);
  }
}

main().catch((err) => {
  console.error("fatal error:", err);
  process.exit(1);
});
