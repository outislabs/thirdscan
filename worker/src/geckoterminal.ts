import { createThrottle, sleep } from "./rateLimiter.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";
const MAX_429_RETRIES = 3;
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000];

// geckoterminal's public api allows 30 calls/min in theory, but was observed
// rate-limiting well before that. stay well under it: ~10 calls/min.
const throttle = createThrottle(10);

interface PoolsResponse {
  data: {
    id?: string;
    relationships?: {
      base_token?: {
        data?: { id?: string };
      };
    };
  }[];
  // present when requested with include=base_token: one entry per distinct
  // base token on the page, keyed by the same "<network>_<address>" id.
  included?: {
    id?: string;
    type?: string;
    attributes?: {
      name?: string | null;
      symbol?: string | null;
      decimals?: number | null;
    };
  }[];
}

interface OhlcvResponse {
  data: {
    attributes: {
      ohlcv_list: [number, number | null, number | null, number | null, number | null, number | null][];
    };
  };
}

export interface TokenMetadata {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface DiscoveredToken {
  address: string;
  poolAddress: string;
  // null when the page's included base_token entry was missing for this
  // token -- callers must not overwrite stored metadata with it.
  metadata: TokenMetadata | null;
}

export interface OhlcvCandle {
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume_usd: number | null;
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

function stripNetworkPrefix(id: string): string | null {
  // ids are formatted "<network>_<address>", e.g. "solana_So1111...".
  const prefix = `${NETWORK}_`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/**
 * Fetches one page of the top solana pools by 24h volume and returns the
 * base token address + pool address pairs referenced on that page, with
 * each base token's symbol/name/decimals from the same response
 * (include=base_token) -- no separate per-token metadata call.
 */
export async function fetchPoolsPage(page: number): Promise<DiscoveredToken[]> {
  const url =
    `${BASE_URL}/networks/${NETWORK}/pools?sort=h24_volume_usd_desc&page=${page}` +
    `&include=base_token`;
  const json = await getJson<PoolsResponse>(url);

  const metadataById = new Map<string, TokenMetadata>();
  for (const entry of json.included ?? []) {
    if (entry.type !== "token" || !entry.id) continue;
    metadataById.set(entry.id, {
      symbol: entry.attributes?.symbol ?? null,
      name: entry.attributes?.name ?? null,
      decimals: entry.attributes?.decimals ?? null,
    });
  }

  const results: DiscoveredToken[] = [];
  for (const pool of json.data ?? []) {
    const baseTokenId = pool.relationships?.base_token?.data?.id;
    const poolId = pool.id;
    if (!baseTokenId || !poolId) continue;
    const address = stripNetworkPrefix(baseTokenId);
    const poolAddress = stripNetworkPrefix(poolId);
    if (!address || !poolAddress) continue;
    results.push({ address, poolAddress, metadata: metadataById.get(baseTokenId) ?? null });
  }
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const OHLCV_TIMEFRAME = "hour";
const OHLCV_AGGREGATE = 1;
const OHLCV_LIMIT = 168; // 7 days of hourly candles

/**
 * Fetches hourly OHLCV candles (last 7 days) for a single pool.
 */
export async function fetchPoolOhlcvHourly(poolAddress: string): Promise<OhlcvCandle[]> {
  const url =
    `${BASE_URL}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${OHLCV_TIMEFRAME}` +
    `?aggregate=${OHLCV_AGGREGATE}&limit=${OHLCV_LIMIT}`;
  const json = await getJson<OhlcvResponse>(url);
  const list = json.data?.attributes?.ohlcv_list ?? [];
  return list.map(([timestamp, open, high, low, close, volume]) => ({
    ts: new Date(timestamp * 1000).toISOString(),
    open,
    high,
    low,
    close,
    volume_usd: volume,
  }));
}
