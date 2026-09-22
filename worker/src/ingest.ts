import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import {
  chunk,
  fetchPoolsPage,
  fetchTokensMulti,
  METRICS_CHUNK_SIZE,
  type DiscoveredToken,
  type TokenMetrics,
} from "./geckoterminal.js";

const CHAIN = "solana";
const DISCOVER_PAGES = [1, 2, 3, 4, 5];
const MAX_TOKENS = 100;
export const PRICE_WORKER_NAME = "geckoterminal";

async function discoverTokens(errors: string[]): Promise<DiscoveredToken[]> {
  // address -> pool address, first-seen wins (pages are sorted by desc 24h
  // volume, so the first pool a token appears in is its top pool).
  const seen = new Map<string, string>();
  for (const page of DISCOVER_PAGES) {
    if (seen.size >= MAX_TOKENS) break;
    try {
      const entries = await fetchPoolsPage(page);
      for (const { address, poolAddress } of entries) {
        if (!seen.has(address)) {
          if (seen.size >= MAX_TOKENS) break;
          seen.set(address, poolAddress);
        }
      }
    } catch (err) {
      errors.push(`discover page ${page}: ${(err as Error).message}`);
    }
  }
  return [...seen.entries()].slice(0, MAX_TOKENS).map(([address, poolAddress]) => ({
    address,
    poolAddress,
  }));
}

async function fetchAllMetrics(addresses: string[], errors: string[]): Promise<TokenMetrics[]> {
  const results: TokenMetrics[] = [];
  for (const batch of chunk(addresses, METRICS_CHUNK_SIZE)) {
    try {
      const metrics = await fetchTokensMulti(batch);
      results.push(...metrics);
    } catch (err) {
      errors.push(`metrics batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }
  return results;
}

async function upsertTokens(
  metrics: TokenMetrics[],
  poolAddressByAddress: Map<string, string>,
  errors: string[],
): Promise<void> {
  if (metrics.length === 0) return;
  const rows = metrics.map((m) => ({
    chain: CHAIN,
    address: m.address,
    symbol: m.symbol,
    name: m.name,
    decimals: m.decimals,
    is_rwa: false,
    pool_address: poolAddressByAddress.get(m.address) ?? null,
  }));
  const { error } = await supabase
    .from("tokens")
    .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
  if (error) {
    errors.push(`upsert tokens: ${error.message}`);
  }
}

async function insertTokenMetrics(metrics: TokenMetrics[], errors: string[]): Promise<void> {
  if (metrics.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const rows = metrics.map((m) => ({
    chain: CHAIN,
    address: m.address,
    price_usd: m.price_usd,
    volume_24h: m.volume_24h,
    liquidity_usd: m.liquidity_usd,
    market_cap: m.market_cap,
    price_change_24h: null,
    source: PRICE_WORKER_NAME,
    fetched_at: fetchedAt,
    is_estimate: false,
  }));
  const { error } = await supabase.from("token_metrics").insert(rows);
  if (error) {
    errors.push(`insert token_metrics: ${error.message}`);
  }
}

/**
 * Runs the price/discovery cycle and returns the tokens discovered this run
 * (address + top pool address), for the ohlcv job to reuse.
 */
export async function runPriceCycle(): Promise<DiscoveredToken[]> {
  const errors: string[] = [];

  const discovered = await discoverTokens(errors);
  console.log(`discovered ${discovered.length} unique base token addresses`);

  const metrics = await fetchAllMetrics(discovered.map((t) => t.address), errors);
  console.log(`fetched metrics for ${metrics.length} tokens`);

  const poolAddressByAddress = new Map(discovered.map((t) => [t.address, t.poolAddress]));
  await upsertTokens(metrics, poolAddressByAddress, errors);
  await insertTokenMetrics(metrics, errors);
  await writeWorkerStatus(PRICE_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`price cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("price cycle completed successfully");
  }

  return discovered;
}
