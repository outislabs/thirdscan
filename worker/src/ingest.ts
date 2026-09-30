import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { fetchPoolsPage, type DiscoveredToken } from "./geckoterminal.js";

const CHAIN = "solana";
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

/**
 * Runs geckoterminal pool discovery and upserts the discovered tokens (with
 * their top pool and metadata) into tokens. price/volume/liquidity/market
 * cap are no longer fetched from geckoterminal -- dexscreener and jupiter
 * cover them -- which leaves geckoterminal's rate limit to discovery and
 * ohlcv. returns the discovered tokens for dexscreener to price.
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
  await writeWorkerStatus(PRICE_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`price cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("price cycle completed successfully");
  }

  return discovered;
}
