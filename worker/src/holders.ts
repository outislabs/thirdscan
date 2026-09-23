import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import {
  fetchAccountOwner,
  fetchTokenLargestAccounts,
  fetchTokenSupply,
  type LargestAccount,
} from "./helius.js";

const CHAIN = "solana";
export const HOLDERS_WORKER_NAME = "helius_holders";
const MAX_TOKENS_PER_RUN = 10;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// getTokenLargestAccounts fails on these with "too many accounts requested"
// (holder count is enormous), and holder concentration isn't a meaningful
// signal for them anyway -- skip proactively instead of retrying and
// failing every cycle.
const SKIPPED_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "wrapped SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

interface CandidateToken {
  address: string;
  decimals: number | null;
}

async function selectCandidateTokens(
  errors: string[],
  notes: string[],
): Promise<CandidateToken[]> {
  const { data: screened, error: screenerError } = await supabase
    .from("v_screener")
    .select("address, decimals")
    .eq("chain", CHAIN)
    .is("risk_flag", null);

  if (screenerError) {
    errors.push(`query v_screener: ${screenerError.message}`);
    return [];
  }
  let candidates = (screened ?? []) as CandidateToken[];
  if (candidates.length === 0) return [];

  const skipped = candidates.filter((c) => c.address in SKIPPED_MINTS);
  if (skipped.length > 0) {
    const names = skipped.map((c) => `${SKIPPED_MINTS[c.address]} (${c.address})`).join(", ");
    // a deliberate, expected skip -- not a failure, so this goes to `notes`
    // (still recorded in worker_status) rather than `errors` (which would
    // mark the cycle as failed every run, forever, since these mints never
    // leave v_screener).
    notes.push(`skipped ${skipped.length} known large mint(s), holder concentration not meaningful: ${names}`);
    candidates = candidates.filter((c) => !(c.address in SKIPPED_MINTS));
  }
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

interface ResolvedAccount extends LargestAccount {
  owner: string | null;
}

interface AggregatedHolder {
  holderAddress: string | null; // resolved owner wallet, or null if unresolved
  tokenAccount: string; // representative account -- see aggregateByOwner
  amount: number;
  decimals: number | null;
}

/**
 * Groups accounts that share a resolved owner, summing their balances (one
 * owner can hold several accounts for the same mint). Accounts whose owner
 * couldn't be resolved are kept as their own row with holderAddress null --
 * never merged into another owner's total or mislabeled as their own owner.
 * The representative tokenAccount for a merged owner is their single
 * largest individual account, just for having something concrete to show.
 */
function aggregateByOwner(entries: ResolvedAccount[]): AggregatedHolder[] {
  const byOwner = new Map<string, ResolvedAccount[]>();
  const unresolved: ResolvedAccount[] = [];

  for (const entry of entries) {
    if (entry.amount === null) continue; // no amount to rank or sum
    if (entry.owner) {
      const group = byOwner.get(entry.owner) ?? [];
      group.push(entry);
      byOwner.set(entry.owner, group);
    } else {
      unresolved.push(entry);
    }
  }

  const rows: AggregatedHolder[] = [];

  for (const [owner, group] of byOwner) {
    const total = group.reduce((sum, e) => sum + (e.amount as number), 0);
    const representative = group.reduce((best, e) =>
      (e.amount as number) > (best.amount as number) ? e : best,
    );
    rows.push({
      holderAddress: owner,
      tokenAccount: representative.address,
      amount: total,
      decimals: representative.decimals,
    });
  }

  for (const entry of unresolved) {
    rows.push({
      holderAddress: null,
      tokenAccount: entry.address,
      amount: entry.amount as number,
      decimals: entry.decimals,
    });
  }

  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}

async function processToken(token: CandidateToken, errors: string[]): Promise<void> {
  const { address } = token;
  const fetchedAt = new Date().toISOString();

  const supply = await fetchTokenSupply(address).catch((err) => {
    errors.push(`getTokenSupply ${address}: ${(err as Error).message}`);
    return null;
  });
  const totalSupplyRaw = supply?.amount ?? null;

  // already sorted descending by the rpc spec, and already capped at 20 --
  // there is no "top 100" here, getTokenLargestAccounts only ever returns 20.
  const largest = await fetchTokenLargestAccounts(address);

  // resolved sequentially, not in parallel: the shared throttle isn't safe
  // against concurrent callers racing its lastCallAt check.
  const resolved: ResolvedAccount[] = [];
  for (const entry of largest) {
    let owner: string | null = null;
    try {
      owner = await fetchAccountOwner(entry.address);
    } catch (err) {
      console.warn(
        `holders: owner resolution failed for account ${entry.address} (mint ${address}): ${(err as Error).message}`,
      );
    }
    resolved.push({ ...entry, owner });
  }

  const aggregated = aggregateByOwner(resolved);

  const percentOf = (rawAmount: number | null): number | null =>
    rawAmount !== null && totalSupplyRaw && totalSupplyRaw > 0
      ? (rawAmount / totalSupplyRaw) * 100
      : null;

  const holderRows = aggregated.map((row, i) => {
    const decimals = row.decimals ?? supply?.decimals ?? token.decimals ?? null;
    const balance = decimals !== null ? row.amount / 10 ** decimals : null;
    return {
      chain: CHAIN,
      address,
      holder_address: row.holderAddress,
      token_account: row.tokenAccount,
      balance,
      percent_of_supply: percentOf(row.amount),
      rank: i + 1,
      source: HOLDERS_WORKER_NAME,
      fetched_at: fetchedAt,
    };
  });

  const sumPercent = (n: number): number | null => {
    if (!totalSupplyRaw || totalSupplyRaw <= 0) return null;
    const slice = aggregated.slice(0, n);
    if (slice.length === 0) return null;
    const rawSum = slice.reduce((sum, row) => sum + row.amount, 0);
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
    // getTokenLargestAccounts gives no way to know total holder count
    // without pagination (which is what we're avoiding); not estimated.
    holder_count: null,
    top10_percent: sumPercent(10),
    top20_percent: sumPercent(20),
    source: HOLDERS_WORKER_NAME,
    fetched_at: fetchedAt,
  });
  if (statsError) {
    errors.push(`insert token_holder_stats for ${address}: ${statsError.message}`);
  }
}

/**
 * For up to MAX_TOKENS_PER_RUN tokens from v_screener with no risk_flag,
 * skipping any fetched in the last 6 hours, fetches the top 20 accounts by
 * balance via helius (getTokenLargestAccounts), resolves each account's
 * owner wallet, aggregates accounts under the same owner, and stores the
 * result plus concentration stats. holder_count is not tracked -- this
 * method has no way to know it.
 */
export async function runHoldersCycle(): Promise<void> {
  const errors: string[] = [];
  const notes: string[] = [];

  if (!env.HELIUS_API_KEY) {
    errors.push("HELIUS_API_KEY not set");
    await writeWorkerStatus(HOLDERS_WORKER_NAME, errors);
    console.error("holders cycle skipped: HELIUS_API_KEY not set");
    return;
  }

  const candidates = await selectCandidateTokens(errors, notes);
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

  // notes (expected, deliberate skips) and errors (actual failures) both
  // land in worker_status.last_error since that's the only text field
  // available, but only errors affect the pass/fail log below -- a skip
  // note alone shouldn't make every cycle read as failed.
  await writeWorkerStatus(HOLDERS_WORKER_NAME, [...notes, ...errors]);

  if (notes.length > 0) {
    console.log(`holders: ${notes.length} note(s):`, notes);
  }

  if (errors.length > 0) {
    console.error(`holders cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("holders cycle completed successfully");
  }
}
