import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { createThrottle } from "./rateLimiter.js";

const BASE_URL = "https://api.dexscreener.com/latest/dex/tokens";
const CHAIN = "solana";
export const DEXSCREENER_WORKER_NAME = "dexscreener";

// the multi-address form of this endpoint caps the total pairs returned
// rather than guaranteeing coverage per address, so high-liquidity tokens
// (stablecoins, wrapped SOL) crowd low-liquidity ones out of the response
// entirely. querying one address at a time avoids that. its own throttle
// runs independently of geckoterminal's, so the two never block each other.
const throttle = createThrottle(60);

interface DexPair {
  chainId: string;
  baseToken: { address: string };
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: { h24?: number | null } | null;
  priceChange?: { h24?: number | null } | null;
  fdv?: number | null;
  marketCap?: number | null;
}

interface DexTokensResponse {
  pairs: DexPair[] | null;
}

interface TokenMetricsRow {
  address: string;
  price_usd: number | null;
  volume_24h: number | null;
  liquidity_usd: number | null;
  market_cap: number | null;
  price_change_24h: number | null;
}

function parseNumeric(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickHighestLiquidityPair(pairs: DexPair[]): DexPair {
  return pairs.reduce((best, pair) => {
    const bestLiquidity = parseNumeric(best.liquidity?.usd) ?? -Infinity;
    const pairLiquidity = parseNumeric(pair.liquidity?.usd) ?? -Infinity;
    return pairLiquidity > bestLiquidity ? pair : best;
  });
}

async function fetchDexscreenerToken(address: string): Promise<TokenMetricsRow | null> {
  await throttle();
  const url = `${BASE_URL}/${address}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DexTokensResponse;

  const pairs = (json.pairs ?? []).filter(
    (p) => p.chainId === CHAIN && p.baseToken?.address === address,
  );
  if (pairs.length === 0) return null;

  const pair = pickHighestLiquidityPair(pairs);
  return {
    address,
    price_usd: parseNumeric(pair.priceUsd),
    volume_24h: parseNumeric(pair.volume?.h24),
    liquidity_usd: parseNumeric(pair.liquidity?.usd),
    market_cap: parseNumeric(pair.marketCap) ?? parseNumeric(pair.fdv),
    price_change_24h: parseNumeric(pair.priceChange?.h24),
  };
}

async function insertTokenMetrics(rows: TokenMetricsRow[], errors: string[]): Promise<void> {
  if (rows.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const records = rows.map((r) => ({
    chain: CHAIN,
    address: r.address,
    price_usd: r.price_usd,
    volume_24h: r.volume_24h,
    liquidity_usd: r.liquidity_usd,
    market_cap: r.market_cap,
    price_change_24h: r.price_change_24h,
    source: DEXSCREENER_WORKER_NAME,
    fetched_at: fetchedAt,
    is_estimate: false,
  }));
  // plain insert, not upsert: each source's rows accumulate independently in
  // token_metrics, so this can never overwrite geckoterminal's rows.
  const { error } = await supabase.from("token_metrics").insert(records);
  if (error) {
    errors.push(`insert token_metrics (dexscreener): ${error.message}`);
  }
}

/**
 * Fetches dexscreener metrics for the given solana token addresses (same
 * token set as the price cycle), one address per request, and inserts them
 * into token_metrics with source='dexscreener'. Picks each token's
 * highest-liquidity solana pair.
 */
export async function runDexscreenerCycle(addresses: string[]): Promise<void> {
  const errors: string[] = [];
  const rows: TokenMetricsRow[] = [];

  for (const address of addresses) {
    try {
      const row = await fetchDexscreenerToken(address);
      if (row) rows.push(row);
    } catch (err) {
      errors.push(`dexscreener ${address}: ${(err as Error).message}`);
    }
  }

  console.log(`dexscreener: matched ${rows.length} of ${addresses.length} requested tokens`);
  await insertTokenMetrics(rows, errors);
  await writeWorkerStatus(DEXSCREENER_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`dexscreener cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("dexscreener cycle completed successfully");
  }
}
