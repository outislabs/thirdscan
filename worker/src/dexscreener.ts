import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { createThrottle } from "./rateLimiter.js";
import { chunk } from "./geckoterminal.js";
import { CHAIN, normalizeAddress } from "./chain.js";

const BASE_URL = "https://api.dexscreener.com/tokens/v1";
// max addresses per tokens/v1 call.
const ADDRESSES_PER_CALL = 30;
export const DEXSCREENER_WORKER_NAME = "dexscreener";
// keeps the `address=in.(...)` query string well under url length limits.
const IMAGE_CHECK_CHUNK_SIZE = 100;

// batched via /tokens/v1/{chainId}/{addresses} (up to 30 per call), which
// returns each token's pair(s) on that chain -- in practice one per token.
// not /latest/dex/tokens/{addresses}: that form caps each response at 30
// pairs *total*, and one liquid token (a stablecoin, weth) can have 30
// pairs by itself, crowding everything else out. measured on robinhood
// chain: 30 addresses/call there matched 72 of 255 tokens vs 208 one at a
// time; tokens/v1 matched 209 in 9 calls. its own throttle runs
// independently of geckoterminal's, so the two never block each other.
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
  info?: { imageUrl?: string | null } | null;
}

// tokens/v1 returns a bare array of pairs, not { pairs: [...] }.
type DexTokensResponse = DexPair[];

interface TokenMetricsRow {
  address: string;
  price_usd: number | null;
  volume_24h: number | null;
  liquidity_usd: number | null;
  market_cap: number | null;
  price_change_24h: number | null;
}

interface DexscreenerResult {
  metrics: TokenMetricsRow;
  imageUrl: string | null;
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

function toResult(address: string, pairs: DexPair[]): DexscreenerResult | null {
  if (pairs.length === 0) return null;
  const pair = pickHighestLiquidityPair(pairs);
  // the image belongs to the base token, not the pair, so any matching pair
  // that carries one will do if the top pair doesn't.
  const imageUrl =
    pair.info?.imageUrl || pairs.find((p) => p.info?.imageUrl)?.info?.imageUrl || null;
  return {
    metrics: {
      address,
      price_usd: parseNumeric(pair.priceUsd),
      volume_24h: parseNumeric(pair.volume?.h24),
      liquidity_usd: parseNumeric(pair.liquidity?.usd),
      market_cap: parseNumeric(pair.marketCap) ?? parseNumeric(pair.fdv),
      price_change_24h: parseNumeric(pair.priceChange?.h24),
    },
    imageUrl,
  };
}

/**
 * Fetches up to 30 token addresses in one call and returns a result per
 * address that has at least one CHAIN pair with it as the base token.
 * pairs are grouped by base token case-insensitively: dexscreener returns
 * eip-55 mixed-case addresses, tokens stores them lowercased.
 */
async function fetchDexscreenerBatch(addresses: string[]): Promise<Map<string, DexscreenerResult>> {
  await throttle();
  const url = `${BASE_URL}/${CHAIN}/${addresses.join(",")}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DexTokensResponse;

  const wanted = new Set(addresses.map(normalizeAddress));
  const pairsByAddress = new Map<string, DexPair[]>();
  for (const p of Array.isArray(json) ? json : []) {
    if (p.chainId !== CHAIN || p.baseToken?.address === undefined) continue;
    const base = normalizeAddress(p.baseToken.address);
    if (!wanted.has(base)) continue;
    const list = pairsByAddress.get(base);
    if (list) list.push(p);
    else pairsByAddress.set(base, [p]);
  }

  const results = new Map<string, DexscreenerResult>();
  for (const [address, pairs] of pairsByAddress) {
    const result = toResult(address, pairs);
    if (result) results.set(address, result);
  }
  return results;
}

/**
 * Sets tokens.image_url from dexscreener, but only where it's currently
 * null: registry logos are authoritative and existing values are never
 * replaced or churned. tokens with no dexscreener image are left alone, so
 * image_url is never set back to null.
 */
async function fillMissingImageUrls(imageUrls: Map<string, string>, errors: string[]): Promise<number> {
  const needsImage: string[] = [];
  for (const batch of chunk([...imageUrls.keys()], IMAGE_CHECK_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address")
      .eq("chain", CHAIN)
      .in("address", batch)
      .is("image_url", null);
    if (error) {
      errors.push(`check tokens image_url: ${error.message}`);
      return 0;
    }
    needsImage.push(...(data ?? []).map((row) => row.address as string));
  }
  if (needsImage.length === 0) return 0;

  // rows already exist (they came from the query above), so this upsert
  // only ever takes the update path, and only image_url changes.
  const rows = needsImage.map((address) => ({
    chain: CHAIN,
    address,
    image_url: imageUrls.get(address)!,
  }));
  const { error } = await supabase
    .from("tokens")
    .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
  if (error) {
    errors.push(`set image_url from dexscreener: ${error.message}`);
    return 0;
  }
  return rows.length;
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
 * Fetches dexscreener metrics for the given token addresses (the price
 * cycle's discovered set plus registry mints), 30 addresses per request,
 * and inserts them into token_metrics with source='dexscreener'. Picks
 * each token's highest-liquidity pair on CHAIN.
 */
export async function runDexscreenerCycle(addresses: string[]): Promise<void> {
  const errors: string[] = [];
  const rows: TokenMetricsRow[] = [];
  const imageUrls = new Map<string, string>();

  const unique = [...new Set(addresses.map(normalizeAddress))];
  let calls = 0;
  for (const batch of chunk(unique, ADDRESSES_PER_CALL)) {
    calls++;
    try {
      for (const result of (await fetchDexscreenerBatch(batch)).values()) {
        rows.push(result.metrics);
        if (result.imageUrl) imageUrls.set(result.metrics.address, result.imageUrl);
      }
    } catch (err) {
      errors.push(`dexscreener batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }

  console.log(
    `dexscreener: matched ${rows.length} of ${unique.length} requested tokens in ${calls} call(s) ` +
      `(${ADDRESSES_PER_CALL} addresses/call)`,
  );
  await insertTokenMetrics(rows, errors);
  const imagesSet = await fillMissingImageUrls(imageUrls, errors);
  console.log(
    `dexscreener: ${imageUrls.size} tokens had an image, set image_url on ${imagesSet} that had none`,
  );
  await writeWorkerStatus(DEXSCREENER_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`dexscreener cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("dexscreener cycle completed successfully");
  }
}
