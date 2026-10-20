-- token_metrics retention: full detail for 7 days, then one row per
-- (chain, address, source, hour), the latest in that hour. see
-- docs/retention-plan.md.
--
-- thin_token_metrics works on a bounded time window so each call is small
-- (a window of a few hours is ~10k rows), which keeps it clear of statement
-- timeouts whether it is called by cron or in a loop over the backlog. it
-- refuses to touch anything newer than 7 days.

create or replace function thin_token_metrics(p_from timestamptz, p_to timestamptz)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from   timestamptz := date_trunc('hour', p_from);
  v_to     timestamptz := date_trunc('hour', p_to);
  v_limit  timestamptz := date_trunc('hour', now()) - interval '7 days';
  v_deleted bigint;
begin
  -- hour-aligned bounds so a (token, source, hour) group is never split
  -- across calls, and never reaches into the 7-day raw window.
  if v_to > v_limit then
    raise exception 'thin_token_metrics: window end % is inside the 7-day raw window (limit %)', v_to, v_limit;
  end if;
  if v_from >= v_to then
    return 0;
  end if;

  with ranked as (
    select id,
           row_number() over (
             partition by chain, address, source, date_trunc('hour', fetched_at)
             order by fetched_at desc, id desc
           ) as rn
    from token_metrics
    where fetched_at >= v_from and fetched_at < v_to
  ),
  gone as (
    delete from token_metrics tm
    using ranked r
    where tm.id = r.id and r.rn > 1
    returning 1
  )
  select count(*) into v_deleted from gone;

  return v_deleted;
end
$$;

-- service role and cron (postgres) only; never callable over anon rpc.
revoke all on function thin_token_metrics(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function thin_token_metrics(timestamptz, timestamptz) to service_role;

-- hourly: thin the two days that sit just beyond the 7-day boundary. the
-- two-day overlap makes a missed run self-healing; already-thinned hours
-- are a no-op.
do $$
begin
  perform cron.unschedule('token-metrics-thinning')
  where exists (select 1 from cron.job where jobname = 'token-metrics-thinning');
end
$$;

select cron.schedule(
  'token-metrics-thinning',
  '7 * * * *',
  $job$
  select thin_token_metrics(
    date_trunc('hour', now()) - interval '9 days',
    date_trunc('hour', now()) - interval '7 days'
  );
  $job$
);
