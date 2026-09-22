import { sleep, throttle } from "./rateLimiter.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";
const MAX_ADDRESSES_PER_METRICS_CALL = 30;
const MAX_429_RETRIES = 3;
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000];

interface PoolsResponse {
  data: {
    relationships?: {
      base_token?: {
        data?: { id?: string };
      };
    };
  }[];
}

interface TokensMultiResponse {
  data: {
    attributes: {
      address: string;
      name: string | null;
      symbol: string | null;
      decimals: number | null;
      price_usd: string | null;
      volume_usd?: { h24?: string | null } | null;
      total_reserve_in_usd: string | null;
      market_cap_usd: string | null;
    };
  }[];
}

export interface TokenMetrics {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  price_usd: number | null;
  volume_24h: number | null;
  liquidity_usd: number | null;
  market_cap: number | null;
}

function parseNumeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`GET ${url} -> 429 (gave up after ${MAX_429_RETRIES} retries)`);
      }
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : RETRY_BACKOFF_MS[attempt];
      console.warn(
        `GET ${url} -> 429, retry ${attempt + 1}/${MAX_429_RETRIES} in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Fetches one page of the top solana pools by 24h volume and returns the
 * unique base token addresses referenced on that page.
 */
export async function fetchPoolsPageBaseTokenAddresses(page: number): Promise<string[]> {
  const url = `${BASE_URL}/networks/${NETWORK}/pools?sort=h24_volume_usd_desc&page=${page}`;
  const json = await getJson<PoolsResponse>(url);
  const addresses = new Set<string>();
  for (const pool of json.data ?? []) {
    const id = pool.relationships?.base_token?.data?.id;
    if (!id) continue;
    // ids are formatted "<network>_<address>", e.g. "solana_So1111...".
    const prefix = `${NETWORK}_`;
    if (id.startsWith(prefix)) {
      addresses.add(id.slice(prefix.length));
    }
  }
  return [...addresses];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetches metrics for up to 30 token addresses in a single call.
 */
export async function fetchTokensMulti(addresses: string[]): Promise<TokenMetrics[]> {
  if (addresses.length === 0) return [];
  if (addresses.length > MAX_ADDRESSES_PER_METRICS_CALL) {
    throw new Error(
      `fetchTokensMulti: ${addresses.length} addresses exceeds max of ${MAX_ADDRESSES_PER_METRICS_CALL}`,
    );
  }
  const url = `${BASE_URL}/networks/${NETWORK}/tokens/multi/${addresses.join(",")}`;
  const json = await getJson<TokensMultiResponse>(url);
  return (json.data ?? []).map((entry) => ({
    address: entry.attributes.address,
    symbol: entry.attributes.symbol,
    name: entry.attributes.name,
    decimals: entry.attributes.decimals,
    price_usd: parseNumeric(entry.attributes.price_usd),
    volume_24h: parseNumeric(entry.attributes.volume_usd?.h24),
    liquidity_usd: parseNumeric(entry.attributes.total_reserve_in_usd),
    market_cap: parseNumeric(entry.attributes.market_cap_usd),
  }));
}

export const METRICS_CHUNK_SIZE = MAX_ADDRESSES_PER_METRICS_CALL;
