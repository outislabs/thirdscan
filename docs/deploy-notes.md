# Deploy notes: 2026-10-20 changes

The repo doesn't record how the worker is supervised on the VPS (pm2, systemd, docker, tmux?), so steps marked **[your supervisor]** need your command. Everything touching Supabase runs from a machine whose `supabase` CLI is logged in to project `gumcgvgsugttsuadqxhv` (the CLI on the dev MacBook is logged in to a different account and returns 403 for it).

## 1. Supabase (laptop or anywhere with CLI access; not the VPS)

```sh
supabase link --project-ref gumcgvgsugttsuadqxhv     # once
supabase db push                                       # applies the two new migrations, in order:
#   20261020000000_lock_down_grants.sql     (fails and rolls back if the result isn't the allowlist)
#   20261020010000_worker_alerting.sql      (needs pg_cron + pg_net; enable them under Database > Extensions if push complains)
```

The two earlier out-of-repo migrations (`...8338ec77...`, `...16e732d7...`) are already in the repo, so `db push` should only list the two new files. If it lists anything else, stop and check `supabase migration list`.

Then verify the grants with the **anon** key (Dashboard > Settings > API Keys; the publishable/anon key, not service_role):

```sh
curl -s "https://gumcgvgsugttsuadqxhv.supabase.co/rest/v1/v_projects?chain=eq.robinhood&select=id" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" | jq length     # expect 14
curl -s -o /dev/null -w "%{http_code}\n" "https://gumcgvgsugttsuadqxhv.supabase.co/rest/v1/tokens?limit=1" \
  -H "apikey: $ANON_KEY"                                                          # expect 401/403 (permission denied)
curl -s -o /dev/null -w "%{http_code}\n" "https://gumcgvgsugttsuadqxhv.supabase.co/rest/v1/worker_status?limit=1" \
  -H "apikey: $ANON_KEY"                                                          # expect 200
```

Check the frontend still loads (it reads the v_* views, `worker_status`, and inserts into `early_access_signups`).

## 2. Alerting (Supabase only; the VPS is not involved)

```sh
supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... WORKER_ALERTS_CRON_SECRET="$(openssl rand -hex 24)"
supabase functions deploy worker-alerts --no-verify-jwt --project-ref gumcgvgsugttsuadqxhv
```

In the SQL editor, store the same cron secret and the project URL in Vault (the cron job reads both at run time):

```sql
select vault.create_secret('<same value as WORKER_ALERTS_CRON_SECRET>', 'worker_alerts_cron_secret');
select vault.create_secret('https://gumcgvgsugttsuadqxhv.supabase.co', 'project_url');
```

Test without waiting for cron:

```sh
curl -i -X POST https://gumcgvgsugttsuadqxhv.supabase.co/functions/v1/worker-alerts -H "x-cron-secret: <secret>"
# 200 {"checked":5,"alerts":0}. First run only records baselines.
select * from cron.job_run_details order by start_time desc limit 5;   -- confirm the job fires every 5 min
```

To see a real alert once: `update worker_alert_config set interval_seconds = 1 where worker_name = 'dexscreener';`, call the function, then set it back to 300.

Expect noise from `blockscout_holders`: its `last_error` usually holds notes (supply mismatch, occasional 500), and every change in that text sends a message.

## 3. VPS: pull and restart the worker

Only `worker/src/dexscreener.ts` (pool_address backfill) and a comment in `index.ts` changed. No new env vars, no new dependencies, so no `npm install` is needed unless `package-lock.json` differs.

```sh
cd <path to thirdscan>/worker
git pull --ff-only origin main
npm run typecheck            # sanity
# [your supervisor] restart, e.g. pm2 restart <name> | systemctl restart <unit> | docker compose up -d --build
```

Also on the VPS: `HELIUS_API_KEY` can be deleted from the VPS's `worker/.env` too (I only removed it from the MacBook copy). Nothing reads it.

Do the Supabase step (1) first or at the same time. The worker change is independent of it, but the grants migration is the one with security impact.

## 4. Confirm after restart (about an hour)

- Worker log line: `dexscreener: set pool_address on N token(s) that had none` should show ~102 on the first cycle, then 0.
- OHLCV fills in at 50 tokens per 15-minute run, so full coverage takes roughly an hour:
  `select count(distinct address) from token_ohlcv where chain = 'robinhood' and address in (select address from v_screener);` should climb from 90 toward ~190. Some illiquid pools will legitimately have few or no candles (GeckoTerminal only emits a candle for hours with trades).
- `worker_status` heartbeats keep landing (the alert job now watches this).

## Not done, needs your decision

- Retention delete on `token_metrics`: `docs/retention-plan.md`.
- Frozen Solana rows: `docs/solana-frozen-rows.md`.
