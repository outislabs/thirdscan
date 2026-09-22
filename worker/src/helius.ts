import { env } from "./env.js";
import { createThrottle } from "./rateLimiter.js";

// helius's rate limits vary by plan; stay conservative until this has been
// run against the account's actual plan and observed to hold up.
const throttle = createThrottle(10);

const MAX_ACCOUNT_PAGES = 50; // safety cap: 50 pages * 1000 = 50k holders per token
const ACCOUNTS_PAGE_LIMIT = 1000;

function rpcUrl(): string {
  return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
}

async function rpcCall<T>(method: string, params: unknown): Promise<T> {
  await throttle();
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "thirdscan", method, params }),
  });
  if (!res.ok) {
    throw new Error(`helius ${method} -> ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) {
    throw new Error(`helius ${method} -> ${json.error.message ?? "unknown error"}`);
  }
  if (json.result === undefined) {
    throw new Error(`helius ${method} -> no result in response`);
  }
  return json.result;
}

export interface TokenSupply {
  amount: number | null;
  decimals: number | null;
}

/**
 * Standard Solana JSON-RPC getTokenSupply, proxied through helius.
 */
export async function fetchTokenSupply(mint: string): Promise<TokenSupply | null> {
  interface Result {
    value?: { amount?: string; decimals?: number } | null;
  }
  const result = await rpcCall<Result>("getTokenSupply", [mint]);
  const value = result.value;
  if (!value) return null;
  const amount = value.amount !== undefined ? Number(value.amount) : null;
  return {
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    decimals: value.decimals ?? null,
  };
}

export interface RawTokenAccount {
  owner: string;
  amount: number;
}

interface GetTokenAccountsResult {
  token_accounts?: { owner?: string; amount?: number; address?: string }[];
  total?: number;
  cursor?: string;
}

/**
 * Pages through helius's getTokenAccounts for a mint, collecting every
 * (owner, amount) pair. Not the standard solana RPC method -- this is
 * helius's enhanced endpoint, paginated via `page` or `cursor` depending on
 * account/version; both are handled here since that isn't pinned down
 * without live testing against the account's actual API responses.
 */
export async function fetchAllTokenAccounts(mint: string): Promise<RawTokenAccount[]> {
  const accounts: RawTokenAccount[] = [];
  let page = 1;
  let cursor: string | undefined;

  for (let i = 0; i < MAX_ACCOUNT_PAGES; i++) {
    const params: Record<string, unknown> = { mint, limit: ACCOUNTS_PAGE_LIMIT };
    if (cursor) {
      params.cursor = cursor;
    } else {
      params.page = page;
    }
    const result = await rpcCall<GetTokenAccountsResult>("getTokenAccounts", params);
    const batch = result.token_accounts ?? [];

    for (const acct of batch) {
      if (!acct.owner || acct.amount === undefined) continue;
      accounts.push({ owner: acct.owner, amount: acct.amount });
    }

    if (result.cursor) {
      cursor = result.cursor;
    } else if (batch.length < ACCOUNTS_PAGE_LIMIT) {
      break;
    } else {
      page += 1;
    }

    if (batch.length === 0) break;
  }

  return accounts;
}
