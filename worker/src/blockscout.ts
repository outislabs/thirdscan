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

export const CREDITS_PER_CALL = 20;
export const FREE_TIER_DAILY_CREDITS = 100_000;

// every request sent, counted before the response comes back: a call that
// errors may still be billed, so the estimate errs high rather than low.
let callCount = 0;

/** requests sent since the worker process started. */
export function blockscoutCallCount(): number {
  return callCount;
}

interface TokenResponse {
  decimals?: string | null;
  total_supply?: string | null;
  holders_count?: string | null;
}

interface HoldersResponse {
  items?: {
    address?: {
      hash?: string | null;
      is_contract?: boolean | null;
      name?: string | null;
      ens_domain_name?: string | null;
    } | null;
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
  isContract: boolean | null;
  // blockscout's name for the address (verified contract name), else its
  // ens name, else null.
  label: string | null;
}

async function getJson<T>(path: string, label: string): Promise<T> {
  if (!env.BLOCKSCOUT_API_KEY) throw new Error("BLOCKSCOUT_API_KEY not set");
  await throttle();
  callCount++;
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
    holders.push({
      address: hash,
      valueRaw,
      isContract: item.address?.is_contract ?? null,
      label: item.address?.name || item.address?.ens_domain_name || null,
    });
  }
  // sort defensively rather than trust the api ordering blindly.
  holders.sort((a, b) => (b.valueRaw > a.valueRaw ? 1 : b.valueRaw < a.valueRaw ? -1 : 0));
  return holders.slice(0, limit);
}

interface AddressResponse {
  creator_address_hash?: string | null;
  creation_transaction_hash?: string | null;
}

interface TransactionResponse {
  from?: { hash?: string | null } | null;
  timestamp?: string | null;
}

interface TokenBalancesResponseItem {
  value?: string | null;
  token?: {
    address_hash?: string | null;
    decimals?: string | null;
    total_supply?: string | null;
  } | null;
}

interface TokenTransfersResponse {
  items?: {
    from?: { hash?: string | null } | null;
    to?: { hash?: string | null } | null;
    total?: { value?: string | null } | null;
  }[];
  next_page_params?: Record<string, string | number | null> | null;
}

export interface TokenCreation {
  creator: string | null; // contract/eoa that executed the create (factory when factory-made)
  deployer: string | null; // sender of the creation transaction
  creationTx: string | null;
  deployedAt: string | null;
}

/** who created a token contract: creator, creation tx sender, and when. 2 calls. */
export async function fetchTokenCreation(address: string): Promise<TokenCreation> {
  const addr = await getJson<AddressResponse>(`/addresses/${address}`, `address ${address}`);
  const creationTx = addr.creation_transaction_hash ?? null;
  if (!creationTx) {
    return { creator: addr.creator_address_hash ?? null, deployer: null, creationTx: null, deployedAt: null };
  }
  const tx = await getJson<TransactionResponse>(`/transactions/${creationTx}`, `creation tx of ${address}`);
  return {
    creator: addr.creator_address_hash ?? null,
    deployer: tx.from?.hash ?? addr.creator_address_hash ?? null,
    creationTx,
    deployedAt: tx.timestamp ?? null,
  };
}

export interface WalletTokenBalance {
  valueRaw: bigint;
  decimals: number | null;
  totalSupplyRaw: bigint | null;
}

/** every erc-20 balance of a wallet, keyed by lowercased token address. 1 call. */
export async function fetchWalletTokenBalances(wallet: string): Promise<Map<string, WalletTokenBalance>> {
  const json = await getJson<TokenBalancesResponseItem[]>(`/addresses/${wallet}/token-balances`, `balances ${wallet}`);
  const out = new Map<string, WalletTokenBalance>();
  for (const item of Array.isArray(json) ? json : []) {
    const token = item.token?.address_hash;
    const valueRaw = parseBigInt(item.value);
    if (!token || valueRaw === null) continue;
    out.set(token.toLowerCase(), {
      valueRaw,
      decimals: parseInteger(item.token?.decimals),
      totalSupplyRaw: parseBigInt(item.token?.total_supply),
    });
  }
  return out;
}

export interface WalletTokenFlow {
  inRaw: bigint; // received (including mints)
  outRaw: bigint; // sent to anyone else
  transfers: number;
  complete: boolean; // false when more pages existed than were read
}

/**
 * a wallet's transfers of one token, newest first, summed by direction.
 * reads up to maxPages pages of 50 (1 call each).
 */
export async function fetchWalletTokenFlow(wallet: string, token: string, maxPages: number): Promise<WalletTokenFlow> {
  const me = wallet.toLowerCase();
  const flow: WalletTokenFlow = { inRaw: 0n, outRaw: 0n, transfers: 0, complete: true };
  let query = `type=ERC-20&token=${token}`;
  for (let page = 0; page < maxPages; page++) {
    const json = await getJson<TokenTransfersResponse>(`/addresses/${wallet}/token-transfers?${query}`, `transfers ${wallet}`);
    for (const item of json.items ?? []) {
      const value = parseBigInt(item.total?.value);
      const from = item.from?.hash?.toLowerCase();
      const to = item.to?.hash?.toLowerCase();
      if (value === null || from === to) continue;
      flow.transfers++;
      if (to === me) flow.inRaw += value;
      else if (from === me) flow.outRaw += value;
    }
    const next = json.next_page_params;
    if (!next) return flow;
    query = `type=ERC-20&token=${token}&` + new URLSearchParams(
      Object.entries(next).map(([k, v]): [string, string] => [k, String(v ?? "")]),
    ).toString();
  }
  flow.complete = false;
  return flow;
}
