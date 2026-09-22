// geckoterminal's public api allows 30 calls/min in theory, but was observed
// rate-limiting well before that. stay well under it: ~10 calls/min.
const MAX_CALLS_PER_MINUTE = 10;
const MIN_INTERVAL_MS = Math.ceil(60_000 / MAX_CALLS_PER_MINUTE); // ~6s

let lastCallAt = 0;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastCallAt = Date.now();
}
