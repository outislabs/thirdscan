export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates an independent throttle that spaces calls out to stay under
 * maxCallsPerMinute. Each source gets its own instance so one API's limit
 * never steals budget from another's.
 */
export function createThrottle(maxCallsPerMinute: number): () => Promise<void> {
  const minIntervalMs = Math.ceil(60_000 / maxCallsPerMinute);
  let lastCallAt = 0;

  return async function throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastCallAt = Date.now();
  };
}
