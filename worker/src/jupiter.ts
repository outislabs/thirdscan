import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import { chunk } from "./geckoterminal.js";
import { createThrottle } from "./rateLimiter.js";

const CHAIN = "solana";
export const JUPITER_WORKER_NAME = "jupiter";
const MINTS_PER_CALL = 50;
const PAGE_SIZE = 1000;

const PRIMARY_BASE = "https://api.jup.ag/price/v3";
const FALLBACK_BASE = "https://lite-api.jup.ag/price/v3";

// keyless, so this stays comfortably under 50/min regardless of whether a
// key is set; the primary/fallback split doesn't get its own budget since
// a fallback replaces the primary call for that batch, not adds to it.
const throttle = createThrottle(50);

interface PriceEntry {
  usdPrice?: number | null;
  liquidity?: number | null;
  priceChange24h?: number | null;
}

type PriceResponse = Record<string, PriceEntry | null | undefined>;

interface JupiterMetrics {
  price_usd: number | null;
  liquidity_usd: number | null;
  price_change_24h: number | null;
}

function parseNumeric(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

async function requestPrices(base: string, addresses: string[], apiKey: string | null) {
  await throttle();
  const url = `${base}?ids=${addresses.join(",")}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return fetch(url, { headers });
}

/**
 * Fetches usd price, liquidity, and 24h price change for up to 50 mints.
 * If JUP_API_KEY is set, tries api.jup.ag first and falls back to the
 * keyless lite-api.jup.ag on 401/403/429 (unauthorized/forbidden/rate
 * limited) for that same batch. Without a key, goes straight to lite-api.
 */
async function fetchJupiterBatch(addresses: string[]): Promise<Map<string, JupiterMetrics>> {
  let res = await requestPrices(
    env.JUP_API_KEY ? PRIMARY_BASE : FALLBACK_BASE,
    addresses,
    env.JUP_API_KEY,
  );

  if (env.JUP_API_KEY && [401, 403, 429].includes(res.status)) {
    res = await requestPrices(FALLBACK_BASE, addresses, null);
  }

  if (!res.ok) {
    throw new Error(`GET jupiter price -> ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as PriceResponse;
  const results = new Map<string, JupiterMetrics>();
  for (const address of addresses) {
    const entry = json[address];
    results.set(address, {
      price_usd: parseNumeric(entry?.usdPrice),
      liquidity_usd: parseNumeric(entry?.liquidity),
      price_change_24h: parseNumeric(entry?.priceChange24h),
    });
  }
  return results;
}

async function selectAllKnownTokenAddresses(errors: string[]): Promise<string[]> {
  const addresses: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address")
      .eq("chain", CHAIN)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query tokens: ${error.message}`);
      break;
    }
    const page = data ?? [];
    addresses.push(...page.map((row) => row.address as string));
    if (page.length < PAGE_SIZE) break;
  }
  return addresses;
}

async function insertTokenMetrics(
  metrics: Map<string, JupiterMetrics>,
  errors: string[],
): Promise<void> {
  // skip tokens jupiter has nothing for at all: a row where every field is
  // null contributes nothing (each field in v_screener/v_token_profile is
  // resolved from whichever source has it non-null) and just bloats the
  // table. a row with e.g. liquidity but no price is still kept -- other
  // fields resolve independently of price.
  const fetchedAt = new Date().toISOString();
  const rows = [...metrics.entries()]
    .filter(([, m]) => m.price_usd !== null || m.liquidity_usd !== null || m.price_change_24h !== null)
    .map(([address, m]) => ({
      chain: CHAIN,
      address,
      price_usd: m.price_usd,
      volume_24h: null,
      liquidity_usd: m.liquidity_usd,
      market_cap: null,
      price_change_24h: m.price_change_24h,
      source: JUPITER_WORKER_NAME,
      fetched_at: fetchedAt,
      is_estimate: false,
    }));
  if (rows.length === 0) return;
  // plain insert, not upsert: accumulates alongside other sources' rows,
  // same as geckoterminal/dexscreener -- never overwrites either of them.
  const { error } = await supabase.from("token_metrics").insert(rows);
  if (error) {
    errors.push(`insert token_metrics (jupiter): ${error.message}`);
  }
}

/**
 * Fetches jupiter usd price, liquidity, and 24h price change for every
 * known solana token (not just this cycle's discovered set) and inserts
 * rows into token_metrics with source='jupiter'. volume_24h and market_cap
 * are always left null -- jupiter's v3 price endpoint doesn't return them.
 */
export async function runJupiterCycle(): Promise<void> {
  const errors: string[] = [];

  const addresses = await selectAllKnownTokenAddresses(errors);
  console.log(`jupiter: pricing ${addresses.length} known tokens`);

  const metrics = new Map<string, JupiterMetrics>();
  for (const batch of chunk(addresses, MINTS_PER_CALL)) {
    try {
      const batchMetrics = await fetchJupiterBatch(batch);
      for (const [address, m] of batchMetrics) {
        metrics.set(address, m);
      }
    } catch (err) {
      errors.push(`jupiter batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }

  await insertTokenMetrics(metrics, errors);
  await writeWorkerStatus(JUPITER_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`jupiter cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("jupiter cycle completed successfully");
  }
}
