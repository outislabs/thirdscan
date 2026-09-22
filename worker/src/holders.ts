import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import { fetchAllTokenAccounts, fetchTokenSupply, type RawTokenAccount } from "./helius.js";

const CHAIN = "solana";
export const HOLDERS_WORKER_NAME = "helius_holders";
const MAX_TOKENS_PER_RUN = 10;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const TOP_HOLDERS_LIMIT = 100;

interface CandidateToken {
  address: string;
  decimals: number | null;
}

async function selectCandidateTokens(errors: string[]): Promise<CandidateToken[]> {
  const { data: screened, error: screenerError } = await supabase
    .from("v_screener")
    .select("address, decimals")
    .eq("chain", CHAIN)
    .is("risk_flag", null);

  if (screenerError) {
    errors.push(`query v_screener: ${screenerError.message}`);
    return [];
  }
  const candidates = (screened ?? []) as CandidateToken[];
  if (candidates.length === 0) return [];

  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: freshRows, error: freshError } = await supabase
    .from("token_holder_stats")
    .select("address")
    .eq("chain", CHAIN)
    .in(
      "address",
      candidates.map((c) => c.address),
    )
    .gte("fetched_at", cutoff);

  if (freshError) {
    errors.push(`check holders freshness: ${freshError.message}`);
    // fail open: treat everyone as stale rather than skip refreshing entirely.
    return candidates;
  }

  const fresh = new Set((freshRows ?? []).map((row) => row.address as string));
  return candidates.filter((c) => !fresh.has(c.address));
}

function aggregateByOwner(accounts: RawTokenAccount[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const { owner, amount } of accounts) {
    balances.set(owner, (balances.get(owner) ?? 0) + amount);
  }
  return balances;
}

async function processToken(token: CandidateToken, errors: string[]): Promise<void> {
  const { address } = token;
  const fetchedAt = new Date().toISOString();

  const supply = await fetchTokenSupply(address).catch((err) => {
    errors.push(`getTokenSupply ${address}: ${(err as Error).message}`);
    return null;
  });
  const decimals = supply?.decimals ?? token.decimals ?? null;
  const totalSupplyRaw = supply?.amount ?? null;

  const accounts = await fetchAllTokenAccounts(address);
  const balances = aggregateByOwner(accounts);
  const holderCount = balances.size;

  const sorted = [...balances.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_HOLDERS_LIMIT);

  const percentOf = (rawAmount: number): number | null =>
    totalSupplyRaw && totalSupplyRaw > 0 ? (rawAmount / totalSupplyRaw) * 100 : null;

  const toUiBalance = (rawAmount: number): number | null =>
    decimals !== null ? rawAmount / 10 ** decimals : null;

  const holderRows = top.map(([holderAddress, rawAmount], i) => ({
    chain: CHAIN,
    address,
    holder_address: holderAddress,
    balance: toUiBalance(rawAmount),
    percent_of_supply: percentOf(rawAmount),
    rank: i + 1,
    source: HOLDERS_WORKER_NAME,
    fetched_at: fetchedAt,
  }));

  const sumPercent = (n: number): number | null => {
    if (!totalSupplyRaw || totalSupplyRaw <= 0) return null;
    const rawSum = sorted.slice(0, n).reduce((acc, [, amount]) => acc + amount, 0);
    return (rawSum / totalSupplyRaw) * 100;
  };

  const { error: deleteError } = await supabase
    .from("token_holders")
    .delete()
    .eq("chain", CHAIN)
    .eq("address", address);
  if (deleteError) {
    errors.push(`clear token_holders for ${address}: ${deleteError.message}`);
    return;
  }

  if (holderRows.length > 0) {
    const { error: insertError } = await supabase.from("token_holders").insert(holderRows);
    if (insertError) {
      errors.push(`insert token_holders for ${address}: ${insertError.message}`);
      return;
    }
  }

  const { error: statsError } = await supabase.from("token_holder_stats").insert({
    chain: CHAIN,
    address,
    holder_count: holderCount > 0 ? holderCount : null,
    top10_percent: sumPercent(10),
    top50_percent: sumPercent(50),
    source: HOLDERS_WORKER_NAME,
    fetched_at: fetchedAt,
  });
  if (statsError) {
    errors.push(`insert token_holder_stats for ${address}: ${statsError.message}`);
  }
}

/**
 * For up to MAX_TOKENS_PER_RUN tokens from v_screener with no risk_flag,
 * skipping any fetched in the last 6 hours, pages through helius holder
 * data and stores the top 100 holders plus concentration stats.
 */
export async function runHoldersCycle(): Promise<void> {
  const errors: string[] = [];

  if (!env.HELIUS_API_KEY) {
    errors.push("HELIUS_API_KEY not set");
    await writeWorkerStatus(HOLDERS_WORKER_NAME, errors);
    console.error("holders cycle skipped: HELIUS_API_KEY not set");
    return;
  }

  const candidates = await selectCandidateTokens(errors);
  const targets = candidates.slice(0, MAX_TOKENS_PER_RUN);
  console.log(
    `holders: ${candidates.length} tokens due for refresh, processing ${targets.length} (cap ${MAX_TOKENS_PER_RUN})`,
  );

  for (const token of targets) {
    try {
      await processToken(token, errors);
    } catch (err) {
      errors.push(`holders ${token.address}: ${(err as Error).message}`);
    }
  }

  await writeWorkerStatus(HOLDERS_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`holders cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("holders cycle completed successfully");
  }
}
