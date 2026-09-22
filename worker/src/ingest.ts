import { supabase } from "./supabase.js";
import {
  chunk,
  fetchPoolsPageBaseTokenAddresses,
  fetchTokensMulti,
  METRICS_CHUNK_SIZE,
  type TokenMetrics,
} from "./geckoterminal.js";

const CHAIN = "solana";
const DISCOVER_PAGES = [1, 2, 3, 4, 5];
const MAX_TOKENS = 100;
const WORKER_NAME = "geckoterminal";

async function discoverAddresses(errors: string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const page of DISCOVER_PAGES) {
    if (seen.size >= MAX_TOKENS) break;
    try {
      const addresses = await fetchPoolsPageBaseTokenAddresses(page);
      for (const address of addresses) {
        seen.add(address);
        if (seen.size >= MAX_TOKENS) break;
      }
    } catch (err) {
      errors.push(`discover page ${page}: ${(err as Error).message}`);
    }
  }
  return [...seen].slice(0, MAX_TOKENS);
}

async function fetchAllMetrics(addresses: string[], errors: string[]): Promise<TokenMetrics[]> {
  const results: TokenMetrics[] = [];
  for (const batch of chunk(addresses, METRICS_CHUNK_SIZE)) {
    try {
      const metrics = await fetchTokensMulti(batch);
      results.push(...metrics);
    } catch (err) {
      errors.push(`metrics batch [${batch[0]}..]: ${(err as Error).message}`);
    }
  }
  return results;
}

async function upsertTokens(metrics: TokenMetrics[], errors: string[]): Promise<void> {
  if (metrics.length === 0) return;
  const rows = metrics.map((m) => ({
    chain: CHAIN,
    address: m.address,
    symbol: m.symbol,
    name: m.name,
    decimals: m.decimals,
    is_rwa: false,
  }));
  const { error } = await supabase
    .from("tokens")
    .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
  if (error) {
    errors.push(`upsert tokens: ${error.message}`);
  }
}

async function insertTokenMetrics(metrics: TokenMetrics[], errors: string[]): Promise<void> {
  if (metrics.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const rows = metrics.map((m) => ({
    chain: CHAIN,
    address: m.address,
    price_usd: m.price_usd,
    volume_24h: m.volume_24h,
    liquidity_usd: m.liquidity_usd,
    market_cap: m.market_cap,
    price_change_24h: null,
    source: WORKER_NAME,
    fetched_at: fetchedAt,
    is_estimate: false,
  }));
  const { error } = await supabase.from("token_metrics").insert(rows);
  if (error) {
    errors.push(`insert token_metrics: ${error.message}`);
  }
}

async function writeWorkerStatus(errors: string[]): Promise<void> {
  const { error } = await supabase.from("worker_status").upsert(
    {
      worker_name: WORKER_NAME,
      last_run_at: new Date().toISOString(),
      last_error: errors.length > 0 ? errors.join("; ").slice(0, 2000) : null,
    },
    { onConflict: "worker_name" },
  );
  if (error) {
    // worker_status itself failed to write; nothing left to log it to but stdout.
    console.error(`failed to write worker_status: ${error.message}`);
  }
}

export async function runCycle(): Promise<void> {
  const errors: string[] = [];

  const addresses = await discoverAddresses(errors);
  console.log(`discovered ${addresses.length} unique base token addresses`);

  const metrics = await fetchAllMetrics(addresses, errors);
  console.log(`fetched metrics for ${metrics.length} tokens`);

  await upsertTokens(metrics, errors);
  await insertTokenMetrics(metrics, errors);
  await writeWorkerStatus(errors);

  if (errors.length > 0) {
    console.error(`cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("cycle completed successfully");
  }
}
