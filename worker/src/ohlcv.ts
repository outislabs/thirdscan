import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { fetchPoolOhlcvHourly } from "./geckoterminal.js";

const CHAIN = "solana";
export const OHLCV_WORKER_NAME = "geckoterminal_ohlcv";
const MAX_TOKENS_PER_RUN = 50;
const STALE_AFTER_MS = 60 * 60 * 1000;
const PAGE_SIZE = 1000;
// concurrent latest-candle lookups against supabase (not geckoterminal --
// its throttle is untouched). each is a limit-1 hit on
// idx_token_ohlcv_chain_address_ts.
const LATEST_TS_CONCURRENCY = 8;

interface PoolToken {
  address: string;
  poolAddress: string;
  attemptedAt: string | null;
}

/**
 * Every token with a pool_address, least recently attempted first: never
 * attempted (null) first, then oldest ohlcv_attempted_at. ties break on
 * address so ordering is deterministic across pages.
 */
async function selectTokensByAttempt(errors: string[]): Promise<PoolToken[]> {
  const tokens: PoolToken[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address, pool_address, ohlcv_attempted_at")
      .eq("chain", CHAIN)
      .not("pool_address", "is", null)
      .order("ohlcv_attempted_at", { ascending: true, nullsFirst: true })
      .order("address")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query tokens with pool_address: ${error.message}`);
      break;
    }
    const page = data ?? [];
    tokens.push(
      ...page.map((row) => ({
        address: row.address as string,
        poolAddress: row.pool_address as string,
        attemptedAt: (row.ohlcv_attempted_at as string | null) ?? null,
      })),
    );
    if (page.length < PAGE_SIZE) break;
  }
  return tokens;
}

/**
 * Walks the attempt-ordered list and takes the first MAX_TOKENS_PER_RUN
 * whose newest stored candle is missing or over an hour old -- a refetch
 * of a fresher one would add at most one candle. candle lookups are lazy
 * (only as far down the list as needed), since postgrest aggregates are
 * disabled here and each lookup is its own query.
 */
async function pickTargets(
  ordered: PoolToken[],
  errors: string[],
): Promise<{ targets: PoolToken[]; checked: number; fresh: number }> {
  const cutoff = Date.now() - STALE_AFTER_MS;
  const targets: PoolToken[] = [];
  let checked = 0;
  let fresh = 0;
  let failed = 0;

  for (let i = 0; i < ordered.length && targets.length < MAX_TOKENS_PER_RUN; i += LATEST_TS_CONCURRENCY) {
    const batch = ordered.slice(i, i + LATEST_TS_CONCURRENCY);
    const latest = await Promise.all(
      batch.map(async (token) => {
        const { data, error } = await supabase
          .from("token_ohlcv")
          .select("ts")
          .eq("chain", CHAIN)
          .eq("address", token.address)
          .order("ts", { ascending: false })
          .limit(1);
        if (error) {
          failed++;
          // fail open: an unknown latest ts is treated as stale, so the
          // token gets refreshed rather than silently skipped.
          return null;
        }
        return (data?.[0]?.ts as string | undefined) ?? null;
      }),
    );

    for (let j = 0; j < batch.length && targets.length < MAX_TOKENS_PER_RUN; j++) {
      checked++;
      const ts = latest[j];
      if (ts !== null && Date.parse(ts) >= cutoff) {
        fresh++;
        continue;
      }
      targets.push(batch[j]);
    }
  }

  if (failed > 0) {
    errors.push(`latest ohlcv ts lookup failed for ${failed} token(s); treated as stale`);
  }
  return { targets, checked, fresh };
}

async function markAttempted(address: string, errors: string[]): Promise<void> {
  const { error } = await supabase
    .from("tokens")
    .update({ ohlcv_attempted_at: new Date().toISOString() })
    .eq("chain", CHAIN)
    .eq("address", address);
  if (error) {
    errors.push(`mark ohlcv attempted for ${address}: ${error.message}`);
  }
}

/**
 * Picks up to MAX_TOKENS_PER_RUN tokens with a pool_address, least recently
 * attempted first (see selectTokensByAttempt / pickTargets), fetches 7 days
 * of hourly OHLCV from each one's pool, and upserts into token_ohlcv
 * (unique on chain, address, ts), so reruns overwrite rather than
 * duplicate rows. every picked token gets ohlcv_attempted_at set, whatever
 * the outcome, so tokens that never return candles rotate to the back.
 */
export async function runOhlcvCycle(): Promise<void> {
  const errors: string[] = [];
  const fetchedAt = new Date().toISOString();
  let candleCount = 0;
  let fetched = 0;
  const skipped = { rateLimited: 0, fetchError: 0, empty: 0, upsertError: 0 };

  const ordered = await selectTokensByAttempt(errors);
  const { targets, checked, fresh } = await pickTargets(ordered, errors);
  const neverAttempted = targets.filter((t) => t.attemptedAt === null).length;
  console.log(
    `ohlcv: ${ordered.length} tokens with pool_address, checked ${checked} in attempt order, ` +
      `${fresh} excluded (newest candle under 1h old), selected ${targets.length} ` +
      `(cap ${MAX_TOKENS_PER_RUN}; ${neverAttempted} never attempted)`,
  );

  for (const { address, poolAddress } of targets) {
    await markAttempted(address, errors);

    let candles;
    try {
      candles = await fetchPoolOhlcvHourly(poolAddress);
    } catch (err) {
      const message = (err as Error).message;
      // geckoterminal.getJson throws "-> 429 (gave up ...)" only after its
      // retries/backoff are exhausted.
      if (message.includes("-> 429")) skipped.rateLimited++;
      else skipped.fetchError++;
      errors.push(`ohlcv ${address} (pool ${poolAddress}): ${message}`);
      continue;
    }

    if (candles.length === 0) {
      skipped.empty++;
      continue;
    }

    const rows = candles.map((c) => ({
      chain: CHAIN,
      address,
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume_usd: c.volume_usd,
      source: OHLCV_WORKER_NAME,
      fetched_at: fetchedAt,
    }));

    const { error } = await supabase
      .from("token_ohlcv")
      .upsert(rows, { onConflict: "chain,address,ts", ignoreDuplicates: false });

    if (error) {
      errors.push(`upsert token_ohlcv for ${address}: ${error.message}`);
      skipped.upsertError++;
      continue;
    }
    candleCount += rows.length;
    fetched++;
  }

  const skippedTotal = skipped.rateLimited + skipped.fetchError + skipped.empty + skipped.upsertError;
  console.log(
    `ohlcv: fetched ${fetched} of ${targets.length} selected tokens (${candleCount} candles upserted), ` +
      `skipped ${skippedTotal} (429 after retries: ${skipped.rateLimited}, other fetch error: ${skipped.fetchError}, ` +
      `no candles returned: ${skipped.empty}, upsert error: ${skipped.upsertError})`,
  );

  await writeWorkerStatus(OHLCV_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`ohlcv cycle completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("ohlcv cycle completed successfully");
  }
}
