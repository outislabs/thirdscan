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
import { CHAIN, ZERO_ADDRESS } from "./chain.js";

const DISCOVER_PAGES = [1, 2, 3, 4, 5];
const MAX_TOKENS = 100;
export const PRICE_WORKER_NAME = "geckoterminal";

async function discoverTokens(errors: string[]): Promise<DiscoveredToken[]> {
  // address -> discovered token, first-seen pool wins (pages are sorted by
  // desc 24h volume, so the first pool a token appears in is its top pool).
  const seen = new Map<string, DiscoveredToken>();
  for (const page of DISCOVER_PAGES) {
    if (seen.size >= MAX_TOKENS) break;
    try {
      const entries = await fetchPoolsPage(page);
      for (const entry of entries) {
        if (entry.address === ZERO_ADDRESS) continue;
        const existing = seen.get(entry.address);
        if (existing) {
          // keep the top pool, but take metadata from a later page if the
          // first one's included entry was missing.
          if (!existing.metadata && entry.metadata) existing.metadata = entry.metadata;
          continue;
        }
        if (seen.size >= MAX_TOKENS) break;
        seen.set(entry.address, { ...entry });
      }
    } catch (err) {
      errors.push(`discover page ${page}: ${(err as Error).message}`);
    }
  }
  return [...seen.values()].slice(0, MAX_TOKENS);
}

/**
 * Upserts every discovered token into tokens: pool_address always, and
 * symbol/name/decimals when discovery returned them. tokens without
 * metadata go in a separate upsert that omits those columns entirely, so a
 * missing included entry never nulls out metadata already stored (e.g. a
 * registry-seeded symbol).
 */
async function upsertTokens(discovered: DiscoveredToken[], errors: string[]): Promise<void> {
  const withMetadata = discovered
    .filter((t) => t.metadata)
    .map((t) => ({
      chain: CHAIN,
      address: t.address,
      symbol: t.metadata!.symbol,
      name: t.metadata!.name,
      decimals: t.metadata!.decimals,
      is_rwa: false,
      pool_address: t.poolAddress,
    }));
  const withoutMetadata = discovered
    .filter((t) => !t.metadata)
    .map((t) => ({
      chain: CHAIN,
      address: t.address,
      is_rwa: false,
      pool_address: t.poolAddress,
    }));

  for (const rows of [withMetadata, withoutMetadata]) {
    if (rows.length === 0) continue;
    const { error } = await supabase
      .from("tokens")
      .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
    if (error) {
      errors.push(`upsert tokens: ${error.message}`);
    }
  }
}

async function fetchAllMetrics(addresses: string[], errors: string[]): Promise<TokenMetrics[]> {
  const results: TokenMetrics[] = [];
  for (const batch of chunk(addresses, METRICS_CHUNK_SIZE)) {
    try {
      results.push(...(await fetchTokensMulti(batch)));
    } catch (err) {
      errors.push(`metrics batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }
  return results;
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
  // plain insert, not upsert: accumulates alongside dexscreener's rows,
  // never overwrites them.
  const { error } = await supabase.from("token_metrics").insert(rows);
  if (error) {
    errors.push(`insert token_metrics: ${error.message}`);
  }
}

/**
 * Runs geckoterminal pool discovery, upserts the discovered tokens (with
 * their top pool and metadata) into tokens, then fetches price / volume /
 * liquidity / market cap for them via tokens/multi and inserts those into
 * token_metrics with source='geckoterminal'. with jupiter paused (solana
 * only), this is the second price source alongside dexscreener. metrics
 * are inserted after the tokens upsert so the token_metrics fk holds.
 * returns the discovered tokens for dexscreener to price.
 */
export async function runPriceCycle(): Promise<DiscoveredToken[]> {
  const errors: string[] = [];

  const discovered = await discoverTokens(errors);
  const missingMetadata = discovered.filter((t) => !t.metadata).length;
  console.log(
    `discovered ${discovered.length} unique base token addresses` +
      (missingMetadata > 0 ? ` (${missingMetadata} without metadata)` : ""),
  );

  await upsertTokens(discovered, errors);

  const metrics = await fetchAllMetrics(discovered.map((t) => t.address), errors);
  console.log(`fetched metrics for ${metrics.length} tokens`);
  await insertTokenMetrics(metrics, errors);

  await writeWorkerStatus(PRICE_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`price cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("price cycle completed successfully");
  }

  return discovered;
}
