import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { env } from "./env.js";
import {
  blockscoutCallCount,
  CREDITS_PER_CALL,
  fetchTokenCreation,
  fetchWalletTokenBalances,
  fetchWalletTokenFlow,
  type WalletTokenBalance,
} from "./blockscout.js";
import { CHAIN, normalizeAddress } from "./chain.js";
import { insertLabelsIfMissing } from "./entities.js";

export const DEPLOYERS_WORKER_NAME = "blockscout_deployers";
const MAX_TOKENS_PER_RUN = 15;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// transfer pages (50 each) read per token when working out how much the
// deployer moved out. beyond this the history is flagged incomplete.
const MAX_TRANSFER_PAGES = 3;
// out_percent at or above this counts as "sold" (see token_deployer_snapshots).
const SOLD_THRESHOLD_PERCENT = 10;
// this job's own ceiling per utc day, so it can't starve the holders job
// (up to 76,800 of the 100k free-tier credits/day).
const DAILY_CREDIT_BUDGET = 15_000;
const PAGE_SIZE = 1000;

interface Candidate {
  address: string;
  symbol: string | null;
  decimals: number | null;
  deployer: string | null; // already-known deployer, if any
  attemptedAt: string | null;
}

let creditsDay = "";
let creditsToday = 0;

/** screener tokens due for detection (no deployer yet) or a 24h refresh. */
async function selectCandidates(errors: string[]): Promise<Candidate[]> {
  const { data: screened, error: screenerError } = await supabase
    .from("v_screener")
    .select("address, symbol, decimals")
    .eq("chain", CHAIN);
  if (screenerError) {
    errors.push(`query v_screener: ${screenerError.message}`);
    return [];
  }
  const addresses = (screened ?? []).map((r) => r.address as string);
  if (addresses.length === 0) return [];

  const deployers = new Map<string, string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("token_deployers")
      .select("address, deployer_address")
      .eq("chain", CHAIN)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      errors.push(`query token_deployers: ${error.message}`);
      return [];
    }
    for (const r of data ?? []) deployers.set(r.address as string, r.deployer_address as string);
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  const attempts = new Map<string, string | null>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address, deployer_attempted_at")
      .eq("chain", CHAIN)
      .order("address")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      errors.push(`query deployer attempts: ${error.message}`);
      return [];
    }
    for (const r of data ?? []) attempts.set(r.address as string, (r.deployer_attempted_at as string | null) ?? null);
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  const cutoff = Date.now() - STALE_AFTER_MS;
  const due: Candidate[] = [];
  for (const r of screened ?? []) {
    const address = r.address as string;
    const attemptedAt = attempts.get(address) ?? null;
    const deployer = deployers.get(address) ?? null;
    // a token with no deployer yet is always due, even if recently
    // attempted, but not more often than hourly so failures can't spin.
    const attemptedMs = attemptedAt ? Date.parse(attemptedAt) : 0;
    const isDue = deployer === null ? Date.now() - attemptedMs > 60 * 60 * 1000 : attemptedMs < cutoff;
    if (isDue) {
      due.push({ address, symbol: (r.symbol as string | null) ?? null, decimals: (r.decimals as number | null) ?? null, deployer, attemptedAt });
    }
  }
  // detection first, then least recently refreshed.
  due.sort((a, b) => {
    if ((a.deployer === null) !== (b.deployer === null)) return a.deployer === null ? -1 : 1;
    return (a.attemptedAt ?? "").localeCompare(b.attemptedAt ?? "");
  });
  return due;
}

function toNumber(raw: bigint, decimals: number | null): number | null {
  return decimals === null ? null : Number(raw) / 10 ** decimals;
}

function percent(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number((numerator * 100_000_000n) / denominator) / 1_000_000;
}

async function processToken(
  token: Candidate,
  balanceCache: Map<string, Map<string, WalletTokenBalance>>,
  errors: string[],
): Promise<void> {
  let deployer = token.deployer;

  if (deployer === null) {
    const creation = await fetchTokenCreation(token.address);
    if (!creation.deployer) {
      errors.push(`deployer ${token.address}: blockscout has no creation info`);
      return;
    }
    deployer = normalizeAddress(creation.deployer);
    const { error } = await supabase.from("token_deployers").upsert(
      {
        chain: CHAIN,
        address: token.address,
        deployer_address: deployer,
        creator_address: creation.creator ? normalizeAddress(creation.creator) : null,
        creation_tx: creation.creationTx,
        deployed_at: creation.deployedAt,
      },
      { onConflict: "chain,address" },
    );
    if (error) {
      errors.push(`upsert token_deployers for ${token.address}: ${error.message}`);
      return;
    }
    await insertLabelsIfMissing(
      [
        {
          address: deployer,
          label: `Deployer of ${token.symbol ?? token.address}`,
          type: "deployer",
          tokenAddress: token.address,
          source: "blockscout_creation_tx",
        },
      ],
      errors,
    );
  }

  let balances = balanceCache.get(deployer);
  if (!balances) {
    balances = await fetchWalletTokenBalances(deployer);
    balanceCache.set(deployer, balances);
  }
  const entry = balances.get(token.address);
  const flow = await fetchWalletTokenFlow(deployer, token.address, MAX_TRANSFER_PAGES);

  const decimals = entry?.decimals ?? token.decimals;
  const balanceRaw = entry?.valueRaw ?? 0n;
  const percentOfSupply = entry
    ? entry.totalSupplyRaw !== null
      ? percent(entry.valueRaw, entry.totalSupplyRaw)
      : null
    : 0;
  const outPercent = flow.inRaw > 0n ? Math.min(percent(flow.outRaw, flow.inRaw) ?? 0, 100) : null;

  let hasSold: boolean | null;
  if (outPercent !== null && outPercent >= SOLD_THRESHOLD_PERCENT) hasSold = true;
  else if (flow.complete) hasSold = false;
  else hasSold = balanceRaw === 0n && flow.transfers > 0 ? true : null;

  const { error } = await supabase.from("token_deployer_snapshots").insert({
    chain: CHAIN,
    address: token.address,
    deployer_address: deployer,
    balance: toNumber(balanceRaw, decimals),
    percent_of_supply: percentOfSupply,
    out_percent: outPercent,
    transfers_seen: flow.transfers,
    transfers_complete: flow.complete,
    has_sold: hasSold,
    fetched_at: new Date().toISOString(),
  });
  if (error) errors.push(`insert token_deployer_snapshots for ${token.address}: ${error.message}`);
}

/**
 * Resolves the deployer of each screener token (creation tx sender, via
 * blockscout), labels it, and snapshots the deployer's position in its own
 * token (balance, share of supply, how much it has moved out). Detection
 * first, then 24h refreshes, capped per run and per day to protect the
 * shared blockscout credit budget. 3-5 calls per token (fewer when the
 * deployer's balances are already cached for the run).
 */
export async function runDeployersCycle(): Promise<void> {
  const errors: string[] = [];

  if (!env.BLOCKSCOUT_API_KEY) {
    errors.push("BLOCKSCOUT_API_KEY not set");
    await writeWorkerStatus(DEPLOYERS_WORKER_NAME, errors);
    console.error("deployers cycle skipped: BLOCKSCOUT_API_KEY not set");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== creditsDay) {
    creditsDay = today;
    creditsToday = 0;
  }
  if (creditsToday >= DAILY_CREDIT_BUDGET) {
    console.log(`deployers: skipped, ~${creditsToday} credits used today (budget ${DAILY_CREDIT_BUDGET})`);
    await writeWorkerStatus(DEPLOYERS_WORKER_NAME, []);
    return;
  }

  const callsBefore = blockscoutCallCount();
  const due = await selectCandidates(errors);
  const targets = due.slice(0, MAX_TOKENS_PER_RUN);
  console.log(
    `deployers: ${due.length} tokens due, processing ${targets.length} ` +
      `(cap ${MAX_TOKENS_PER_RUN}; ${targets.filter((t) => t.deployer === null).length} new)`,
  );

  const balanceCache = new Map<string, Map<string, WalletTokenBalance>>();
  let processed = 0;
  for (const token of targets) {
    const { error } = await supabase
      .from("tokens")
      .update({ deployer_attempted_at: new Date().toISOString() })
      .eq("chain", CHAIN)
      .eq("address", token.address);
    if (error) errors.push(`mark deployer attempted for ${token.address}: ${error.message}`);
    try {
      await processToken(token, balanceCache, errors);
      processed++;
    } catch (err) {
      errors.push(`deployer ${token.address}: ${(err as Error).message}`);
    }
  }

  const credits = (blockscoutCallCount() - callsBefore) * CREDITS_PER_CALL;
  creditsToday += credits;
  console.log(`deployers: processed ${processed} of ${targets.length}, ~${credits} credits this run, ~${creditsToday} today`);

  await writeWorkerStatus(DEPLOYERS_WORKER_NAME, errors);
  if (errors.length > 0) console.error(`deployers cycle completed with ${errors.length} error(s):`, errors);
  else console.log("deployers cycle completed successfully");
}
