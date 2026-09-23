import { env } from "./env.js";
import { createThrottle } from "./rateLimiter.js";

// helius's free tier allows 10 requests/sec (600/min); stay conservative
// against that.
const throttle = createThrottle(300);

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

export interface LargestAccount {
  // the token ACCOUNT address, not the owning wallet -- getTokenLargestAccounts
  // doesn't return an owner. holders.ts resolves it separately via
  // fetchAccountOwner and aggregates accounts that share one.
  address: string;
  amount: number | null;
  decimals: number | null;
}

/**
 * Standard Solana JSON-RPC getTokenLargestAccounts, proxied through helius:
 * the top 20 token accounts for a mint by balance, in a single call, already
 * sorted descending by the RPC spec. No pagination, so no statement-timeout
 * risk on high-holder-count mints (SOL, USDC) the way getTokenAccounts had.
 */
export async function fetchTokenLargestAccounts(mint: string): Promise<LargestAccount[]> {
  interface Entry {
    address?: string;
    amount?: string;
    decimals?: number;
  }
  interface Result {
    value?: Entry[] | null;
  }
  const result = await rpcCall<Result>("getTokenLargestAccounts", [mint]);
  return (result.value ?? [])
    .filter((entry): entry is Entry & { address: string } => !!entry.address)
    .map((entry) => {
      const amount = entry.amount !== undefined ? Number(entry.amount) : null;
      return {
        address: entry.address,
        amount: amount !== null && Number.isFinite(amount) ? amount : null,
        decimals: entry.decimals ?? null,
      };
    });
}

/**
 * Resolves the owning wallet of an SPL token account via standard Solana
 * getAccountInfo (jsonParsed), proxied through helius. Returns null if the
 * account can't be parsed as a token account -- callers should treat that
 * as "unresolved", not as any kind of fallback owner.
 */
export async function fetchAccountOwner(accountAddress: string): Promise<string | null> {
  interface Result {
    value?: {
      data?: {
        parsed?: {
          info?: {
            owner?: string;
          };
        };
      } | null;
    } | null;
  }
  const result = await rpcCall<Result>("getAccountInfo", [
    accountAddress,
    { encoding: "jsonParsed" },
  ]);
  return result.value?.data?.parsed?.info?.owner ?? null;
}
