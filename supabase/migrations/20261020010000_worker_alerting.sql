-- worker alerting. a pg_cron job calls the worker-alerts edge function every
-- 5 minutes; the function compares worker_status to the config below and
-- sends a telegram message. runs entirely inside supabase so it still fires
-- when the worker host is down.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- per-worker expected cadence. stale = last_run_at older than 3x
-- interval_seconds. paused jobs (jupiter, helius_holders) are deliberately
-- absent: they are meant to be stale and carry a "paused" last_error.
create table if not exists worker_alert_config (
  worker_name      text primary key,
  interval_seconds integer not null check (interval_seconds > 0),
  -- false = staleness alerts only. blockscout_holders keeps routine notes
  -- (supply mismatch, transient 500s) in last_error, so alerting on every
  -- change would be noise.
  alert_on_error   boolean not null default true
);

insert into worker_alert_config (worker_name, interval_seconds, alert_on_error) values
  ('dexscreener',         300, true),
  ('geckoterminal',       300, true),
  ('registry_seed',       300, true),
  ('geckoterminal_ohlcv', 900, true),
  ('blockscout_holders',  900, false)
on conflict (worker_name) do nothing;

-- what was last alerted, so a persistent condition sends one message, not
-- one per run.
create table if not exists worker_alert_state (
  worker_name       text primary key,
  is_stale          boolean not null default false,
  last_error_seen   text,
  updated_at        timestamptz not null default now()
);

-- service role only (the edge function). rls on with no policies, and the
-- supabase default grants stripped, same as security_audit.
alter table worker_alert_config enable row level security;
alter table worker_alert_state  enable row level security;
revoke all on worker_alert_config from anon, authenticated;
revoke all on worker_alert_state  from anon, authenticated;

-- the cron job reads the shared secret from vault at run time, so nothing
-- sensitive lives in this file. create it once, out of band:
--   select vault.create_secret('<random string>', 'worker_alerts_cron_secret');
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
-- the same random string goes in the function's WORKER_ALERTS_CRON_SECRET.
do $$
begin
  perform cron.unschedule('worker-alerts')
  where exists (select 1 from cron.job where jobname = 'worker-alerts');
end
$$;

select cron.schedule(
  'worker-alerts',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/worker-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_alerts_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $job$
);
