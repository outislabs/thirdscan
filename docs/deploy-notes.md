# Deploy notes: 2026-10-20 changes

The repo doesn't record how the worker is supervised on the VPS (pm2, systemd, docker, tmux?), so steps marked **[your supervisor]** need your command. Everything touching Supabase runs from a machine whose `supabase` CLI is logged in to project `gumcgvgsugttsuadqxhv` (the CLI on the dev MacBook is logged in to a different account and returns 403 for it).

## Done 2026-10-20 (from the dev Mac, CLI linked to the project)

- Migrations applied: `lock_down_grants`, `worker_alerting`, `token_metrics_retention`, `token_metrics_fetched_at_index`.
- Anon check passed (14 rows from `v_projects?chain=eq.robinhood`; raw tables denied).
- `worker-alerts` deployed (`supabase functions deploy worker-alerts --no-verify-jwt --use-api`).
- token_metrics backed up, thinned; Solana archived and deleted. Files are in `archive/` (gitignored; copy them somewhere safe, they exist only on the Mac).

## 1. You still need to do: Telegram secrets and Vault entries

Run from the repo (CLI linked) with your real values. Pick the cron secret yourself; the same value goes in both places.

```sh
CRON_SECRET="$(openssl rand -hex 24)"; echo "$CRON_SECRET"   # keep this for the SQL below
supabase secrets set --project-ref gumcgvgsugttsuadqxhv \
  TELEGRAM_BOT_TOKEN='<bot token>' \
  TELEGRAM_CHAT_ID='<chat id>' \
  WORKER_ALERTS_CRON_SECRET="$CRON_SECRET"
```

Then in the Dashboard SQL editor (secrets stay out of the repo):

```sql
select vault.create_secret('<the CRON_SECRET value>', 'worker_alerts_cron_secret');
select vault.create_secret('https://gumcgvgsugttsuadqxhv.supabase.co', 'project_url');
```

(If either name already exists, `vault.create_secret` errors; use `vault.update_secret` on the existing id instead.) Secrets set after deployment are picked up by the running function, no redeploy needed.

Test:

```sh
curl -i -X POST https://gumcgvgsugttsuadqxhv.supabase.co/functions/v1/worker-alerts -H "x-cron-secret: $CRON_SECRET"
# expect 200 {"checked":5,"alerts":0}. The first run records baselines and sends nothing.
```
```sql
select jobname, schedule from cron.job;                                   -- worker-alerts, token-metrics-thinning
select status, return_message from cron.job_run_details order by start_time desc limit 5;
```
To see one real message: `update worker_alert_config set interval_seconds = 1 where worker_name = 'dexscreener';`, call the function, then set it back to 300.

## 2. VPS: pull and restart the worker

Only `worker/src/dexscreener.ts` (pool_address backfill) and a comment in `index.ts` changed. No new env vars, no new dependencies, so no `npm install` is needed unless `package-lock.json` differs.

```sh
cd <path to thirdscan>/worker
git pull --ff-only origin main
npm run typecheck            # sanity
# [your supervisor] restart, e.g. pm2 restart <name> | systemctl restart <unit> | docker compose up -d --build
```

Also on the VPS: `HELIUS_API_KEY` can be deleted from the VPS's `worker/.env` too (I only removed it from the MacBook copy). Nothing reads it.

Do the Supabase step (1) first or at the same time. The worker change is independent of it, but the grants migration is the one with security impact.

## 2b. New worker jobs (wallets/entities)

Same restart as above. The worker now also runs `blockscout_deployers` and `entity_labels` every 30 minutes. They use the existing `BLOCKSCOUT_API_KEY`; no new env vars. Expect ~14k extra Blockscout credits on the first day (one-time deployer backfill), capped at 15k/day by the job, on top of the holders job's up-to-76.8k/day.

## 3. Confirm after restart (about an hour)

- Worker log line: `dexscreener: set pool_address on N token(s) that had none` should show ~102 on the first cycle, then 0.
- OHLCV fills in at 50 tokens per 15-minute run, so full coverage takes roughly an hour:
  `select count(distinct address) from token_ohlcv where chain = 'robinhood' and address in (select address from v_screener);` should climb from 90 toward ~190. Some illiquid pools will legitimately have few or no candles (GeckoTerminal only emits a candle for hours with trades).
- `worker_status` heartbeats keep landing (the alert job now watches this).

## Notes

- The retention plan is in `docs/retention-plan.md` (now executed); `docs/solana-frozen-rows.md` lists what was archived. `VACUUM FULL token_metrics` was not run: the freed space is reusable but not returned to the OS yet. Do it at a quiet moment if you want the disk back (brief exclusive lock).
- The worker on the VPS still contains the paused Solana code; it is harmless (no solana rows can be written because `CHAIN` is robinhood).
- Remove `HELIUS_API_KEY` from the VPS `worker/.env` as well.
