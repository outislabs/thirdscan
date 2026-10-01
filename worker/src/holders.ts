import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import {
  blockscoutCallCount,
  CREDITS_PER_CALL,
  FREE_TIER_DAILY_CREDITS,
  fetchTokenInfo,
  fetchTopHolders,
} from "./blockscout.js";
import { CHAIN, normalizeAddress } from "./chain.js";

export const HOLDERS_WORKER_NAME = "blockscout_holders";
const MAX_TOKENS_PER_RUN = 20;
const TOP_HOLDERS = 20;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

interface CandidateToken {
  address: string;
  decimals: number | null;
  attemptedAt: string | null;
}

// credits spent in the current utc day by this process, for the per-run
// log line. resets on restart, so after one it undercounts the day.
let creditsDay = "";
let creditsToday = 0;

/**
 * Every token on the chain, least recently attempted first: never
 * attempted (null) first, then oldest holders_attempted_at. ties break on
 * address so ordering is deterministic across pages.
 */
async function selectAttemptOrder(errors: string[]): Promise<Map<string, string | null> | null> {
  const order = new Map<string, string | null>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address, holders_attempted_at")
      .eq("chain", CHAIN)
      .order("holders_attempted_at", { ascending: true, nullsFirst: true })
      .order("address")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query holders attempt order: ${error.message}`);
      return null;
    }
    const page = data ?? [];
    for (const row of page) {
      order.set(row.address as string, (row.holders_attempted_at as string | null) ?? null);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return order;
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
  const screenedRows = (screened ?? []) as { address: string; decimals: number | null }[];
  if (screenedRows.length === 0) return [];

  // order screened tokens least recently attempted first. if the order
  // can't be read, fall back to v_screener's order rather than skip the run.
  const attemptOrder = await selectAttemptOrder(errors);
  const byAddress = new Map(screenedRows.map((row) => [row.address, row]));
  let candidates: CandidateToken[];
  if (attemptOrder) {
    candidates = [];
    for (const [address, attemptedAt] of attemptOrder) {
      const row = byAddress.get(address);
      if (row) candidates.push({ ...row, attemptedAt });
    }
  } else {
    candidates = screenedRows.map((row) => ({ ...row, attemptedAt: null }));
  }

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

async function markAttempted(address: string, errors: string[]): Promise<void> {
  const { error } = await supabase
    .from("tokens")
    .update({ holders_attempted_at: new Date().toISOString() })
    .eq("chain", CHAIN)
    .eq("address", address);
  if (error) {
    errors.push(`mark holders attempted for ${address}: ${error.message}`);
  }
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
    is_contract: h.isContract,
    label: h.label,
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
 * skipping any fetched in the last 6 hours, least recently attempted
 * first (every picked token gets holders_attempted_at set, whatever the
 * outcome, so ones that keep failing rotate to the back), fetches the top 20 holders by
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

  const callsBefore = blockscoutCallCount();
  const candidates = await selectCandidateTokens(errors);
  const targets = candidates.slice(0, MAX_TOKENS_PER_RUN);
  const neverAttempted = targets.filter((t) => t.attemptedAt === null).length;
  console.log(
    `holders: ${candidates.length} tokens due for refresh, processing ${targets.length} ` +
      `(cap ${MAX_TOKENS_PER_RUN}; ${neverAttempted} never attempted)`,
  );

  let processed = 0;
  for (const token of targets) {
    await markAttempted(token.address, errors);
    try {
      await processToken(token, errors, notes);
      processed++;
    } catch (err) {
      errors.push(`holders ${token.address}: ${(err as Error).message}`);
    }
  }
  console.log(`holders: fetched ${processed} of ${targets.length} tokens`);

  const calls = blockscoutCallCount() - callsBefore;
  const credits = calls * CREDITS_PER_CALL;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== creditsDay) {
    creditsDay = today;
    creditsToday = 0;
  }
  creditsToday += credits;
  console.log(
    `holders: blockscout ${calls} call(s), ~${credits} credits this run; ` +
      `~${creditsToday} of ${FREE_TIER_DAILY_CREDITS} free-tier credits used today (utc, since worker start)`,
  );

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
