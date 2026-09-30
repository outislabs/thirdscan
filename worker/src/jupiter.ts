import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import { chunk } from "./geckoterminal.js";
import { createThrottle } from "./rateLimiter.js";

const CHAIN = "solana";
export const JUPITER_WORKER_NAME = "jupiter";
const MINTS_PER_CALL = 50;
const PAGE_SIZE = 1000;

const PRIMARY_HOST = "https://api.jup.ag";
const FALLBACK_HOST = "https://lite-api.jup.ag";
const PRICE_PATH = "/price/v3";
// token search takes a comma-separated list of mints and returns one entry
// per mint it knows, including its icon url.
const TOKENS_PATH = "/tokens/v2/search";
// keeps the `address=in.(...)` query string well under url length limits.
const IMAGE_CHECK_CHUNK_SIZE = 100;

// keyless, so this stays comfortably under 50/min regardless of whether a
// key is set; the primary/fallback split doesn't get its own budget since
// a fallback replaces the primary call for that batch, not adds to it.
// price and token-icon calls share this one budget.
const throttle = createThrottle(50);

interface PriceEntry {
  usdPrice?: number | null;
  liquidity?: number | null;
  priceChange24h?: number | null;
}

type PriceResponse = Record<string, PriceEntry | null | undefined>;

type TokenSearchResponse = { id?: string; icon?: string | null }[];

interface JupiterMetrics {
  price_usd: number | null;
  liquidity_usd: number | null;
  price_change_24h: number | null;
}

function parseNumeric(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

async function request(host: string, pathAndQuery: string, apiKey: string | null) {
  await throttle();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return fetch(`${host}${pathAndQuery}`, { headers });
}

/**
 * GETs a jupiter endpoint. If JUP_API_KEY is set, tries api.jup.ag first
 * and falls back to the keyless lite-api.jup.ag on 401/403/429
 * (unauthorized/forbidden/rate limited) for that same call. Without a key,
 * goes straight to lite-api.
 */
async function jupiterGet<T>(pathAndQuery: string, label: string): Promise<T> {
  let res = await request(
    env.JUP_API_KEY ? PRIMARY_HOST : FALLBACK_HOST,
    pathAndQuery,
    env.JUP_API_KEY,
  );

  if (env.JUP_API_KEY && [401, 403, 429].includes(res.status)) {
    res = await request(FALLBACK_HOST, pathAndQuery, null);
  }

  if (!res.ok) {
    throw new Error(`GET jupiter ${label} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetches usd price, liquidity, and 24h price change for up to 50 mints.
 */
async function fetchJupiterBatch(addresses: string[]): Promise<Map<string, JupiterMetrics>> {
  const json = await jupiterGet<PriceResponse>(`${PRICE_PATH}?ids=${addresses.join(",")}`, "price");
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
 * Fetches icon urls for up to 50 mints. mints jupiter doesn't know, or
 * knows without an icon, are simply absent from the result.
 */
async function fetchJupiterIcons(addresses: string[]): Promise<Map<string, string>> {
  const json = await jupiterGet<TokenSearchResponse>(
    `${TOKENS_PATH}?query=${addresses.join(",")}`,
    "tokens",
  );
  const wanted = new Set(addresses);
  const icons = new Map<string, string>();
  for (const entry of json ?? []) {
    if (entry.id && entry.icon && wanted.has(entry.id)) icons.set(entry.id, entry.icon);
  }
  return icons;
}

async function selectTokensWithoutImage(errors: string[]): Promise<string[]> {
  const addresses: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address")
      .eq("chain", CHAIN)
      .is("image_url", null)
      .order("address")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query tokens without image_url: ${error.message}`);
      break;
    }
    const page = data ?? [];
    addresses.push(...page.map((row) => row.address as string));
    if (page.length < PAGE_SIZE) break;
  }
  return addresses;
}

/**
 * Lowest-precedence image source: registry logos, then dexscreener, then
 * jupiter. runs after both of those in the cycle and only ever fills
 * image_url where it is still null -- re-checked right before the write,
 * so it can't overwrite a value set since the candidate list was read.
 * mints without a jupiter icon are left alone, so nothing is set to null.
 */
async function fillMissingImageUrls(errors: string[]): Promise<void> {
  const candidates = await selectTokensWithoutImage(errors);
  const icons = new Map<string, string>();
  for (const batch of chunk(candidates, MINTS_PER_CALL)) {
    try {
      for (const [address, icon] of await fetchJupiterIcons(batch)) icons.set(address, icon);
    } catch (err) {
      errors.push(`jupiter tokens batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }

  let set = 0;
  for (const batch of chunk([...icons.keys()], IMAGE_CHECK_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address")
      .eq("chain", CHAIN)
      .in("address", batch)
      .is("image_url", null);
    if (error) {
      errors.push(`check tokens image_url: ${error.message}`);
      continue;
    }
    const rows = (data ?? []).map((row) => ({
      chain: CHAIN,
      address: row.address as string,
      image_url: icons.get(row.address as string)!,
    }));
    if (rows.length === 0) continue;
    // rows already exist (they came from the query above), so this upsert
    // only ever takes the update path, and only image_url changes.
    const { error: upsertError } = await supabase
      .from("tokens")
      .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
    if (upsertError) {
      errors.push(`set image_url from jupiter: ${upsertError.message}`);
      continue;
    }
    set += rows.length;
  }

  console.log(
    `jupiter: ${candidates.length} tokens without image_url, found ${icons.size} icons, set image_url on ${set}`,
  );
}

/**
 * Fetches jupiter usd price, liquidity, and 24h price change for every
 * known solana token (not just this cycle's discovered set) plus every
 * seeded registry mint, and inserts rows into token_metrics with
 * source='jupiter'. volume_24h and market_cap are always left null --
 * jupiter's v3 price endpoint doesn't return them.
 *
 * registryAddresses must already have tokens rows (see runRegistrySeed);
 * the known-tokens set already covers every pool-discovered token that the
 * price cycle managed to upsert. discovered addresses that didn't make it
 * into tokens are deliberately excluded -- the token_metrics fk would
 * reject the whole insert.
 *
 * then fills any still-null tokens.image_url from jupiter's token icons
 * (see fillMissingImageUrls).
 */
export async function runJupiterCycle(registryAddresses: string[] = []): Promise<void> {
  const errors: string[] = [];

  const known = await selectAllKnownTokenAddresses(errors);
  const addresses = [...new Set([...known, ...registryAddresses])];
  const knownSet = new Set(known);
  const registryInKnown = registryAddresses.filter((a) => knownSet.has(a)).length;
  const registryExtra = registryAddresses.length - registryInKnown;
  console.log(
    `jupiter: pricing ${addresses.length} tokens (${known.length} known, ` +
      `of which ${registryInKnown} are registry mints` +
      (registryExtra > 0 ? `; plus ${registryExtra} registry mints not in the known set` : "") +
      ")",
  );

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
  await fillMissingImageUrls(errors);
  await writeWorkerStatus(JUPITER_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`jupiter cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("jupiter cycle completed successfully");
  }
}
