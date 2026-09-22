import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { fetchPoolOhlcvHourly, type DiscoveredToken } from "./geckoterminal.js";

const CHAIN = "solana";
export const OHLCV_WORKER_NAME = "geckoterminal_ohlcv";
const MAX_TOKENS_PER_RUN = 25;
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Narrows the discovered token list down to those whose newest stored
 * candle is missing or older than an hour, so a run only refetches tokens
 * that actually need it.
 */
async function selectStaleTokens(tokens: DiscoveredToken[], errors: string[]): Promise<DiscoveredToken[]> {
  if (tokens.length === 0) return [];
  const addresses = tokens.map((t) => t.address);
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();

  const { data, error } = await supabase
    .from("token_ohlcv")
    .select("address")
    .eq("chain", CHAIN)
    .in("address", addresses)
    .gte("ts", cutoff);

  if (error) {
    errors.push(`check ohlcv freshness: ${error.message}`);
    // fail open: treat everyone as stale rather than skip refreshing entirely.
    return tokens;
  }

  const fresh = new Set((data ?? []).map((row) => row.address as string));
  return tokens.filter((t) => !fresh.has(t.address));
}

/**
 * For up to MAX_TOKENS_PER_RUN stale tokens, fetches 7 days of hourly OHLCV
 * from their top pool and upserts into token_ohlcv (unique on chain,
 * address, ts), so reruns overwrite rather than duplicate rows.
 */
export async function runOhlcvCycle(tokens: DiscoveredToken[]): Promise<void> {
  const errors: string[] = [];
  const fetchedAt = new Date().toISOString();
  let candleCount = 0;

  const stale = await selectStaleTokens(tokens, errors);
  const targets = stale.slice(0, MAX_TOKENS_PER_RUN);
  console.log(
    `ohlcv: ${stale.length} of ${tokens.length} tokens stale, refreshing ${targets.length} (cap ${MAX_TOKENS_PER_RUN})`,
  );

  for (const { address, poolAddress } of targets) {
    let candles;
    try {
      candles = await fetchPoolOhlcvHourly(poolAddress);
    } catch (err) {
      errors.push(`ohlcv ${address} (pool ${poolAddress}): ${(err as Error).message}`);
      continue;
    }

    if (candles.length === 0) continue;

    const rows = candles.map((c) => ({
      chain: CHAIN,
      address,
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume_usd: c.volume_usd,
      source: OHLCV_WORKER_NAME,
      fetched_at: fetchedAt,
    }));

    const { error } = await supabase
      .from("token_ohlcv")
      .upsert(rows, { onConflict: "chain,address,ts", ignoreDuplicates: false });

    if (error) {
      errors.push(`upsert token_ohlcv for ${address}: ${error.message}`);
      continue;
    }
    candleCount += rows.length;
  }

  console.log(`ohlcv cycle upserted ${candleCount} candles across ${targets.length} tokens`);

  await writeWorkerStatus(OHLCV_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`ohlcv cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("ohlcv cycle completed successfully");
  }
}
