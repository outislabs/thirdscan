# Thirdscan backend: status audit

Audited 2026-10-20 ~06:15 UTC. Read-only: no code, data, services or deployments were changed. Secrets are reported as set / not set only.

## TL;DR

- **Pipeline is healthy and fresh.** Price, registry, OHLCV and holders jobs all heartbeat on schedule; every active job is within its interval. The only recorded errors are one Blockscout 500 and a few supply-mismatch notes (expected).
- **All work is pushed.** `main` = `origin/main` (2f9f2c5), working tree clean.
- **The brief's premise about `v_projects` does not reproduce.** It returns 14 rows, all `chain = 'robinhood'` (11 verified). See section 5 for the likely causes of an empty result on the consumer side.
- **This audit ran on a MacBook, not a VPS.** Nothing for Thirdscan runs on this machine. Runtime state below comes from the worker's own `worker_status` heartbeats in Supabase. Process supervision, uptime and raw logs live on whatever host runs the worker and could not be inspected.
- **Main gaps:** no API layer (clients read Supabase views directly), no dev/insider tracking, no unbounded-growth control on `token_metrics` (1.8M rows), and Solana data is frozen since 2026-09-30.

## 1. Repo

| | |
|---|---|
| Remote | `github.com/outislabs/thirdscan`, branch `main` |
| Sync | 0 ahead / 0 behind `origin/main` after fetch |
| Uncommitted | none |
| Layout | `worker/` (TypeScript, `tsx`, ~2.2k lines) and `supabase/migrations/` (25 files). No API, frontend or infra code in this repo. |

Worker modules (`worker/src/`): `index.ts` (scheduler) · `ingest.ts` + `geckoterminal.ts` (discovery, OHLCV) · `dexscreener.ts` (prices) · `registry.ts` (seeds `tokens` from `rwa_issuers`) · `holders.ts` + `blockscout.ts` (top holders) · `ohlcv.ts` · `jupiter.ts` (Solana, paused, not called) · `verifyRegistry.ts` (`npm run verify-registry`) · `rateLimiter.ts`, `workerStatus.ts`, `chain.ts`, `env.ts`, `supabase.ts`.

Last 10 commits:

```
2f9f2c5 2026-10-06 worker: verify-registry script comparing rwa_issuers to its migrations
6a9b1da 2026-10-06 revoke writes on v_token_registry with audit snapshot; seed robinhood projects
7e8b54e 2026-10-01 projects table + v_projects; capture remote-only v_token_registry migration
c22cd31 2026-10-01 holders: cap 20 tokens per run (max 76,800 credits/day vs 100k free tier)
91f0b1c 2026-10-01 holders: cap 25, least-recently-attempted ordering, per-run credit logging
c8478d0 2026-09-30 token_holders: is_contract and label from blockscout; expose in view
94d8b50 2026-09-30 holders: blockscout top-20 for robinhood chain; remove helius path
2d16154 2026-09-30 dexscreener: batch 30 addresses per call via tokens/v1/{chainId}
0a0f529 2026-09-30 price registry mints via dexscreener; mark paused jobs in worker_status
a4437bc 2026-09-30 switch worker to robinhood chain only
```

Housekeeping noted: a comment in `index.ts` still says holders has a "10 tokens" per-run cap (now 20).

## 2. Runtime

| Check | Result |
|---|---|
| This host | MacBook Air (Darwin x86_64), up 27 min. No docker, pm2, systemd or cron; no worker process; no log files. |
| Worker is running | **Yes, elsewhere.** Heartbeats landed 2 minutes before the audit (below). Host, supervisor and restart count are unknown from here. |

Per-job heartbeats (`worker_status`, checked 06:15 UTC):

| Job | Last run | Interval | State |
|---|---|---|---|
| dexscreener | 06:13:55 (2 min ago) | 5 min | OK |
| geckoterminal (discovery) | 06:13:46 (2 min ago) | 5 min | OK |
| registry_seed | 06:13:47 (2 min ago) | 5 min | OK |
| geckoterminal_ohlcv | 06:06:43 (9 min ago) | 15 min | OK |
| blockscout_holders | 06:08:04 (8 min ago) | 15 min | OK, with recorded notes (section 6) |
| jupiter | 2026-09-30 16:44 | n/a | Paused (Solana-only), by design |
| helius_holders | 2026-09-30 16:27 | n/a | Paused (path removed), by design |

Crash loops can't be ruled out from here, but 15-minute and 5-minute jobs all landing on time is consistent with a stable process.

## 3. Data pipeline

- **Chain:** Robinhood Chain only (`chain = 'robinhood'`, chain id 4663). Solana code remains but is paused.
- **Providers:** DexScreener (prices/volume/liquidity, 30 addresses per call), GeckoTerminal (pool discovery, hourly OHLCV), Blockscout Pro API (holders, 2 calls/token, 2 req/s, free tier 100k credits/day), Supabase (storage + PostgREST). No direct RPC use in the worker.
- **Secrets:** `SUPABASE_URL` set · `SUPABASE_SERVICE_ROLE_KEY` set · `BLOCKSCOUT_API_KEY` set · `JUP_API_KEY` not set (optional, job paused) · `HELIUS_API_KEY` set in `worker/.env` but **no code reads it** (stale; consider removing).
- **Written by the worker:** `tokens`, `token_metrics`, `token_ohlcv`, `token_holders`, `token_holder_stats`, `worker_status`. `rwa_issuers` and `projects` are written only by migrations (worker reads `rwa_issuers`).
- **Read by clients (anon):** views `v_screener`, `v_token_profile`, `v_token_holders`, `v_token_holder_stats`, `v_token_ohlcv`, `v_projects`, `v_token_registry`. Base tables have RLS with no anon policies.

## 4. Freshness (as of 2026-10-20 06:15 UTC)

| Table / view | Rows | Latest |
|---|---|---|
| `tokens` | 3,099 (1,365 robinhood · 1,734 solana) | created 04:55 today; `ohlcv_attempted_at` 06:06; `holders_attempted_at` 06:07 |
| `token_metrics` | 1,818,304 | 06:13:55 (dexscreener) · 06:13:46 (geckoterminal) · jupiter 2026-09-30 16:44 |
| `token_ohlcv` | 64,213 (51,375 robinhood · 12,838 solana) | candle 06:00, fetched 06:00 |
| `token_holders` | 27,963 (24,003 robinhood · 3,960 solana) | 06:07:58 |
| `token_holder_stats` | 15,155 | 06:07:58 |
| `rwa_issuers` | 1,221 (1,026 solana · 195 robinhood) | added 2026-09-30 (matches migrations exactly, verified 2026-10-06) |
| `projects` | 14 | seeded 2026-10-06 |
| `worker_status` | 7 | 06:13:55 |
| `security_audit` | 2 | 2026-10-06 (v_token_registry fix) |
| `early_access_signups` | 2 | 2026-10-16 (written by the frontend; anon insert-only) |
| `v_screener` / `v_token_profile` | 192 each | all robinhood, all dexscreener-priced |
| `v_token_holders` / `v_token_holder_stats` | 27,963 / 1,474 | |
| `v_token_ohlcv` | 64,213 | |
| `v_projects` | 14 | |
| `v_token_registry` | 1,221 | |

Why `v_screener` is 192 of 3,099: the view only includes tokens with a price, volume and liquidity row fetched in the **last 30 minutes**. That drops all Solana rows (frozen since 09-30) and Robinhood tokens DexScreener has no current pair for.

## 5. Why `v_projects` "returns no Robinhood Chain rows"

**It does return them.** A service-role read of `v_projects` returns 14 rows, all `chain = 'robinhood'` (11 `is_verified`, 3 not: Arcus, Relay, Blockscout). The base table `projects` has the same 14. The view and the table are fine.

If a consumer sees zero rows, in likely order:

1. **Chain-value mismatch.** The stored value is the lowercase string `robinhood` (the same value used everywhere else: `CHAIN` in `worker/src/chain.ts`). A filter on `robinhood-chain`, `Robinhood Chain` or `4663` matches nothing.
2. **Anon access not as expected.** `v_projects` is granted `select` to `anon` and revoked from everything else, but I had no anon key in `worker/.env`, so I did not test the anon path. Quick check (with the anon key, not the service key): `GET /rest/v1/v_projects?chain=eq.robinhood` should return 14 rows.
3. **Wrong project / stale cache.** The consumer pointing at a different Supabase project, or a client caching an earlier empty response (the table was empty before 2026-10-06).

**What populates it:** nothing automatic. No worker job writes `projects`. Rows come only from migrations (`20261001120000_seed_projects_robinhood.sql`) or manual inserts with the service role. The view hides `notes` by design. Adding or editing projects means a new timestamped migration.

## 6. Errors

Raw worker/API logs are not available from this machine. The only error trail is `worker_status.last_error`, which currently holds:

- `blockscout_holders`: (a) one token where Blockscout's top-20 holder sum exceeded its own `total_supply`, so percentages were left null (expected, recorded as a note); (b) one `500 Internal Server Error` from Blockscout for a single token (transient/upstream, token retried on a later run).
- All other active jobs: `last_error = null`.
- Paused jobs carry the "paused -- solana-only provider" marker.

Context: 1,547 of the robinhood `token_holder_stats` history rows have `top20_percent = null`, from the same supply-mismatch condition (Blockscout balances vs reported supply disagree for some tokens).

## 7. Features

| Feature | State | Notes |
|---|---|---|
| Token screener (price, volume, liquidity, market cap, 24h change) | **Working** | 192 live robinhood tokens, 5-minute refresh via DexScreener |
| Risk flags (`fake_volume`, `low_liquidity`) | **Working, basic** | Computed in the view: 175 clear, 11 `fake_volume`, 6 `low_liquidity`. Only volume/liquidity heuristics; no honeypot, mint-authority or ownership checks. |
| RWA / stock-token registry | **Working** | 195 Robinhood + 1,026 Solana issuers; `is_rwa` and `issuer_name` in the screener (121 of 192 are RWA) |
| Holder stats (top-20, concentration, holder count) | **Working** | 190 of 192 screener tokens have stats; 179 robinhood tokens refreshed in the last 6h |
| Wallet labels / contract flag on holders | **Partial** | Blockscout `is_contract` and name/ENS label only (1,895 labelled holder rows, 6,283 flagged contracts). No curated or cross-chain labelling. |
| OHLCV (hourly candles) | **Partial** | 90 of 192 screener tokens have candles (needs a GeckoTerminal pool; many stock tokens have none) |
| Projects directory | **Partial** | Table, view and 14 seeded rows exist; manual curation only |
| Chainlink price feeds for stock tokens | **Researched, not built** | 36 of 195 registry tokens have a feed proxy; mapping is by ticker only (see session notes) |
| Dev / insider tracking (deployer, early buyers, linked wallets) | **Missing** | No code or schema |
| API layer | **Missing** | Clients call Supabase PostgREST views directly with the anon key; no server-side API, auth, rate limiting or caching in this repo |
| Solana pipeline | **Paused / stale** | 1,734 tokens and 12.8k candles frozen at 2026-09-30 |
| Alerting / monitoring | **Missing** | Only `worker_status`; nothing watches it |

## Open risks

- **Out-of-repo schema changes.** Two migrations (`v_token_registry` 2026-10-01, `early_access_signups` 2026-10-05) were applied to the remote outside the repo, with UUID-style names, probably from an app builder. The first shipped with full write grants to anon (fixed 2026-10-06; audit in `security_audit`). Other objects may be affected the same way.
- **No retention on `token_metrics`** (1.8M rows in ~4 weeks, append-only) while `v_screener` runs five lateral lookups per token against it. Query cost will keep growing.
- **Holder snapshot is delete-then-insert, not atomic.** If the insert fails after the delete, a token ends up with no holders until the next run (the failure is recorded in `worker_status`).
- **Single unmonitored worker process** on an unseen host.

## Next steps (prioritized)

1. **Settle the `v_projects` question** with the consumer: confirm the filter value (`robinhood`), then run the anon check in section 5. If it returns 14 rows, the backend is done.
2. **Confirm where the worker runs** and add supervision plus alerting: a check that fails if any `worker_status.last_run_at` exceeds 2× its interval. That table already has what's needed.
3. **Audit grants on every object** (`information_schema.role_table_grants` for `anon` / `authenticated`) and close the loop with whoever applies out-of-repo migrations: commit them through the repo and use the `revoke all` then `grant select` pattern on every new view.
4. **Add retention** for `token_metrics` (e.g. keep 7 days raw, downsample older) before `v_screener` slows down.
5. **Make the holder replace atomic** (single transaction or RPC) so a failed insert can't leave a token empty.
6. **Build the API layer** if the product needs more than direct PostgREST: caching, rate limits, and a stable contract over the views.
7. **Chainlink feed ingestion** for the 36 matched stock tokens (ticker-keyed mapping, proxies verified on-chain 2026-10-06), as a price cross-check against DexScreener.
8. **Dev/insider tracking:** deployer address, first-N buyers, holder-to-deployer links, using Blockscout.
9. **Improve OHLCV coverage** for tokens without a GeckoTerminal pool (derive from DexScreener pairs or an on-chain source).
10. **Cleanup:** remove unused `HELIUS_API_KEY`, fix the stale "10 tokens" comment in `index.ts`, and decide whether to keep or delete the paused Solana code and rows.
