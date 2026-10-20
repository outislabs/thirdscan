# Frozen Solana rows (listed only, nothing deleted)

Counted 2026-10-20 via service-role reads. The worker has run robinhood-only since 2026-09-30; jupiter and helius_holders are paused, so none of these rows has been written since (newest `token_metrics` solana row: 2026-09-30 16:44 UTC).

| Table | Solana rows | Robinhood rows | Notes |
|---|---|---|---|
| `tokens` | 1,734 | 1,374 | solana tokens are not in `v_screener` (price rows are 20+ days old, outside its 30-minute window) |
| `token_metrics` | ~383,409 | ~1,446,000 | jupiter 196,581 · geckoterminal 97,757 · dexscreener 89,071 |
| `token_ohlcv` | 12,838 | 51,827 | |
| `token_holders` | 3,960 | 24,173 | |
| `token_holder_stats` | 483 | 14,805 | |
| `rwa_issuers` | 1,026 | 195 | reference data from migrations, not worker output; still shown by `v_token_registry` |

Deleting `tokens` rows cascades (FK `on delete cascade`) to `token_metrics`, `token_ohlcv`, `token_holders` and `token_holder_stats`, so one `delete from tokens where chain = 'solana'` would remove everything above except `rwa_issuers`. Archive first if wanted (e.g. `\copy (select * from token_metrics where chain = 'solana') to ...`, or a Supabase backup). Which of archive / delete / keep is your call; `rwa_issuers` solana rows are a separate decision since the registry view exposes them.
