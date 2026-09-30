import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import { fetchTokenInfo, fetchTopHolders } from "./blockscout.js";
import { CHAIN, normalizeAddress } from "./chain.js";

export const HOLDERS_WORKER_NAME = "blockscout_holders";
const MAX_TOKENS_PER_RUN = 10;
const TOP_HOLDERS = 20;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

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

/** raw / supply as a percentage, or null when supply is unknown or zero. */
function percentOf(raw: bigint, totalSupplyRaw: bigint | null): number | null {
  if (totalSupplyRaw === null || totalSupplyRaw <= 0n) return null;
  // scale before dividing so bigint division keeps 1e-6 % precision.
  return Number((raw * 100_000_000n) / totalSupplyRaw) / 1_000_000;
}

async function processToken(token: CandidateToken, errors: string[], notes: string[]): Promise<void> {
  const { address } = token;
  const fetchedAt = new Date().toISOString();

  const info = await fetchTokenInfo(address);
  // on evm, balances belong to wallets directly: no token accounts to
  // resolve or aggregate, so each holder is one row keyed by its wallet.
  const holders = await fetchTopHolders(address, TOP_HOLDERS);
  const decimals = info.decimals ?? token.decimals ?? null;

  // blockscout occasionally answers with an empty holders page for a token
  // it reports holders for. treat that as a failed fetch and keep the
  // previous snapshot, rather than clearing it and storing nothing.
  if (holders.length === 0 && (info.holdersCount ?? 0) > 0) {
    errors.push(`holders ${address}: empty holders page but holders_count=${info.holdersCount}; kept previous snapshot`);
    return;
  }

  // balances and total_supply both come from blockscout's index, and for
  // some tokens they disagree (e.g. top holders summing to more than the
  // reported supply). percentages from such a snapshot would be wrong --
  // possibly over 100% -- so they're left null; balances are still stored.
  const topSum = holders.reduce((sum, h) => sum + h.valueRaw, 0n);
  const supplyConsistent = info.totalSupplyRaw !== null && topSum <= info.totalSupplyRaw;
  const supplyForPercent = supplyConsistent ? info.totalSupplyRaw : null;
  if (!supplyConsistent && info.totalSupplyRaw !== null) {
    notes.push(`holders ${address}: top ${holders.length} sum exceeds blockscout total_supply; percentages left null`);
  }

  const holderRows = holders.map((h, i) => ({
    chain: CHAIN,
    address,
    holder_address: normalizeAddress(h.address),
    token_account: null,
    balance: decimals !== null ? Number(h.valueRaw) / 10 ** decimals : null,
    percent_of_supply: percentOf(h.valueRaw, supplyForPercent),
    rank: i + 1,
    source: HOLDERS_WORKER_NAME,
    fetched_at: fetchedAt,
  }));

  const sumPercent = (n: number): number | null => {
    const slice = holders.slice(0, n);
    if (slice.length === 0) return null;
    return percentOf(
      slice.reduce((sum, h) => sum + h.valueRaw, 0n),
      supplyForPercent,
    );
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
    // blockscout's own indexed count of addresses holding the token -- an
    // exact count from the explorer's index, not an estimate.
    holder_count: info.holdersCount,
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
 * skipping any fetched in the last 6 hours, fetches the top 20 holders by
 * balance from blockscout (robinhood chain's explorer) and stores them plus
 * concentration stats and blockscout's holder count. 2 blockscout calls
 * per token.
 */
export async function runHoldersCycle(): Promise<void> {
  const errors: string[] = [];
  // expected, per-token data caveats -- recorded, but don't fail the cycle.
  const notes: string[] = [];

  if (!env.BLOCKSCOUT_API_KEY) {
    errors.push("BLOCKSCOUT_API_KEY not set");
    await writeWorkerStatus(HOLDERS_WORKER_NAME, errors);
    console.error("holders cycle skipped: BLOCKSCOUT_API_KEY not set");
    return;
  }

  const candidates = await selectCandidateTokens(errors);
  const targets = candidates.slice(0, MAX_TOKENS_PER_RUN);
  console.log(
    `holders: ${candidates.length} tokens due for refresh, processing ${targets.length} (cap ${MAX_TOKENS_PER_RUN})`,
  );

  let processed = 0;
  for (const token of targets) {
    try {
      await processToken(token, errors, notes);
      processed++;
    } catch (err) {
      errors.push(`holders ${token.address}: ${(err as Error).message}`);
    }
  }
  console.log(`holders: fetched ${processed} of ${targets.length} tokens`);

  // notes and errors both land in worker_status.last_error (the only text
  // field), but only errors make the cycle read as failed below.
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
