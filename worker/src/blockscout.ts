import { env } from "./env.js";
import { createThrottle } from "./rateLimiter.js";
import { EVM_CHAIN_ID } from "./chain.js";

// blockscout pro api, rest v2, scoped to robinhood chain. the key goes in
// the `apikey` query param, so request urls are never put in error
// messages -- those end up in worker_status, which anon can read.
const BASE_URL = `https://api.blockscout.com/${EVM_CHAIN_ID}/api/v2`;

// free tier: 5 requests/sec and 100k credits/day, 20 credits per call.
// 2/sec leaves headroom on the per-second limit; the daily budget is
// bounded by the holders job's per-run cap and cadence instead.
const throttle = createThrottle(120);

interface TokenResponse {
  decimals?: string | null;
  total_supply?: string | null;
  holders_count?: string | null;
}

interface HoldersResponse {
  items?: {
    address?: { hash?: string | null } | null;
    value?: string | null;
  }[];
}

export interface TokenInfo {
  decimals: number | null;
  totalSupplyRaw: bigint | null;
  holdersCount: number | null;
}

export interface TokenHolder {
  address: string; // wallet (or contract) holding the token, as returned
  valueRaw: bigint; // balance in base units
}

async function getJson<T>(path: string, label: string): Promise<T> {
  if (!env.BLOCKSCOUT_API_KEY) throw new Error("BLOCKSCOUT_API_KEY not set");
  await throttle();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE_URL}${path}${sep}apikey=${env.BLOCKSCOUT_API_KEY}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`blockscout ${label} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function parseBigInt(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function parseInteger(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** decimals, raw total supply, and blockscout's indexed holder count. */
export async function fetchTokenInfo(address: string): Promise<TokenInfo> {
  const json = await getJson<TokenResponse>(`/tokens/${address}`, `token ${address}`);
  return {
    decimals: parseInteger(json.decimals),
    totalSupplyRaw: parseBigInt(json.total_supply),
    holdersCount: parseInteger(json.holders_count),
  };
}

/**
 * First page of a token's holders (50 per page), which blockscout returns
 * sorted by balance descending -- so the top 20 are always on page one.
 */
export async function fetchTopHolders(address: string, limit: number): Promise<TokenHolder[]> {
  const json = await getJson<HoldersResponse>(`/tokens/${address}/holders`, `holders ${address}`);
  const holders: TokenHolder[] = [];
  for (const item of json.items ?? []) {
    const hash = item.address?.hash;
    const valueRaw = parseBigInt(item.value);
    if (!hash || valueRaw === null) continue;
    holders.push({ address: hash, valueRaw });
  }
  // sort defensively rather than trust the api ordering blindly.
  holders.sort((a, b) => (b.valueRaw > a.valueRaw ? 1 : b.valueRaw < a.valueRaw ? -1 : 0));
  return holders.slice(0, limit);
}
