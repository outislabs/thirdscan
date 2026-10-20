# Frontend views: wallets, entities, dev tracking, insights

Read-only, `SELECT` for `anon` and `authenticated`, PostgREST at `https://gumcgvgsugttsuadqxhv.supabase.co/rest/v1/<view>`. All data is `chain = 'robinhood'`. Addresses are **lowercase**; lowercase before filtering. The raw tables behind them return 401 to anon.

## v_insights
Auto-generated daily (pg_cron `generate-insights`, 00:20 UTC, in Supabase; independent of the worker host). One record per type, token and UTC day.

| column | type | notes |
|---|---|---|
| id | bigint | |
| chain | text | |
| type | text | `new_token`, `top_mover`, `volume_spike`, `holder_concentration_jump`, `new_risk_flag`, `deployer_sold` |
| token_address | text | |
| symbol, name, image_url | text | |
| headline | text | ready to display, e.g. `COWL -87.0% in 24h` |
| numbers | jsonb | the figures behind it (see below) |
| created_at | timestamptz | |

Example: `v_insights?order=created_at.desc&limit=50`, `?type=eq.deployer_sold`, `?token_address=eq.0x...`.

`numbers` keys per type:
- `new_token`: price_usd, liquidity_usd, volume_24h, market_cap, is_rwa, added_at
- `top_mover`: direction (`up`/`down`), rank (1-5), price_change_24h, price_usd, volume_24h, liquidity_usd
- `volume_spike`: volume_24h, avg_prev_volume_24h, ratio, liquidity_usd, price_change_24h
- `holder_concentration_jump`: top10_percent, top10_percent_prev, change_points, top20_percent, holder_count
- `new_risk_flag`: risk_flag, vol_liq_ratio, volume_24h, liquidity_usd, prev_volume_24h, prev_liquidity_usd
- `deployer_sold`: deployer_address, out_percent, out_percent_prev, deployer_percent, deployer_percent_prev

Rules: movers = top 5 up / 5 down among unflagged tokens with >= $10k liquidity and volume; volume spike = >= 3x the token's own 7-day average and >= $10k; concentration jump = top-10 share up >= 5 points vs ~24h ago; new risk flag = flagged now, not ~24h ago (same `fake_volume` / `low_liquidity` rules as `v_screener`); deployer sold = deployer's out_percent crossed 10% since its previous snapshot. Thresholds live in `generate_insights()`.

## v_token_dev (dev / insider tracking, one row per token with a detected deployer)

| column | type | notes |
|---|---|---|
| chain, address, symbol, name | text | token |
| deployer_address | text | sender of the creation transaction |
| creator_address | text | contract that executed the create; differs from the deployer when a factory made the token (all stock/RWA tokens) |
| deployed_at | timestamptz | |
| deployer_balance | numeric | deployer's current token balance |
| deployer_percent | numeric | % of supply held now (0-100) |
| deployer_out_percent | numeric | % of the tokens the deployer ever received that have left its wallet; null if it never received any |
| deployer_has_sold | boolean | `deployer_out_percent >= 10`; null when unknown (long history, still holds) |
| deployer_history_complete | boolean | false when the deployer has more than 150 transfers of the token, so out_percent is partial |
| team_percent, team_wallets | numeric, int | combined % and count of wallets labeled `team` that are in the stored top-20 holders |
| insider_percent | numeric | deployer_percent + team_percent |
| refreshed_at | timestamptz | refreshed about every 24h |

Caveat: "out" means tokens left the deployer wallet; the chain cannot distinguish a sale from adding liquidity or a plain transfer. Factory-made tokens (RWA) show a deployer position of 0 because the factory's caller never holds them.

## v_wallet_summary / v_wallet_holdings / v_wallet_deployed / v_entity_labels
Filter by `wallet_address=eq.<lowercase address>` (or `address=eq.` on labels).

**v_wallet_summary**: `chain, wallet_address, labels (jsonb array of {label, type, token_address}), tokens_held, total_value_usd, tokens_deployed`. One row per known wallet (top-20 holder, deployer, or labeled). Wallets we have never seen return no row.

**v_wallet_holdings**: `wallet_address, chain, token_address, symbol, name, image_url, rank, balance, percent_of_supply, is_contract, price_usd, value_usd, fetched_at, source`. `source` is `top_holders` (the stored top 20 of each token) or `deployer_snapshot` (the deployer's own tracked position when it isn't a stored top holder; `rank` is null). A wallet holding a token outside its top 20 is not visible.

**v_wallet_deployed**: `wallet_address, chain, token_address, symbol, name, deployed_at, deployer_percent, deployer_out_percent, deployer_has_sold`.

**v_entity_labels**: `chain, address, label, type, token_address, source, updated_at`. `type` is one of `deployer, team, cex, lp_pool, bridge, burn, smart_money`. `token_address` null = label applies everywhere. Populated automatically: `deployer` (creation tx, per token, source `blockscout_creation_tx`), `lp_pool` / `bridge` (top-holder contracts whose Blockscout name looks like a pool/pair/router/bridge, source `blockscout_name`), `burn` (zero and dead addresses, seed). **`team`, `cex`, `smart_money` have no automatic source**: they are empty until someone inserts rows with the service role (e.g. a migration). `v_token_dev.team_percent` and `insider_percent` only move once `team` rows exist.

## Operational notes
- Needs the VPS worker restarted: the `blockscout_deployers` job (15 tokens / 30 min, ~76 Blockscout credits per token, 15k credits/day ceiling) detects the remaining ~180 deployers over roughly 6 hours, then refreshes each every 24h. 15 tokens are populated now. `v_token_dev` fills as it runs; `deployer_sold` insights need two snapshots a day apart.
- `entity_labels` job (`entity_labels` in `worker_status`) is DB-only.
- Staleness alerts for both new jobs were added to `worker_alert_config`.
