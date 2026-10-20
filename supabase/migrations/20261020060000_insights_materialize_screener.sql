-- generate_insights evaluated v_screener four times and timed out under the
-- api's statement timeout. same logic (see 20261020050000 for thresholds),
-- but the screener is materialized once into a temp table.

create or replace function generate_insights(p_date date default (now() at time zone 'utc')::date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chain constant text := 'robinhood';
  v_total integer := 0;
  v_n integer;
begin
  -- v_screener runs five lateral lookups per token against token_metrics;
  -- evaluate it once instead of once per insight type.
  create temp table tmp_screener on commit drop as
    select * from v_screener where chain = v_chain;

  -- new tokens: added in the last 24h and already priced.
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select s.chain, 'new_token', s.address, s.symbol,
         format('New token: %s listed with $%s liquidity', s.symbol, to_char(round(coalesce(s.liquidity_usd, 0)), 'FM999,999,999,990')),
         jsonb_build_object(
           'price_usd', s.price_usd, 'liquidity_usd', s.liquidity_usd,
           'volume_24h', s.volume_24h, 'market_cap', s.market_cap,
           'is_rwa', s.is_rwa, 'added_at', s.created_at),
         p_date
  from tmp_screener s
  where s.chain = v_chain and s.created_at >= now() - interval '24 hours'
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  -- biggest 24h movers, both directions.
  with eligible as (
    select s.* from tmp_screener s
    where s.chain = v_chain and s.risk_flag is null
      and s.liquidity_usd >= 10000 and s.volume_24h >= 10000
      and s.price_change_24h is not null
  ), ranked as (
    select e.*,
           row_number() over (order by e.price_change_24h desc) as rk_up,
           row_number() over (order by e.price_change_24h asc)  as rk_down
    from eligible e
  )
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select r.chain, 'top_mover', r.address, r.symbol,
         format('%s %s%s%% in 24h', r.symbol, case when r.price_change_24h > 0 then '+' else '' end, round(r.price_change_24h, 1)),
         jsonb_build_object(
           'direction', case when r.price_change_24h > 0 then 'up' else 'down' end,
           'rank', case when r.price_change_24h > 0 then r.rk_up else r.rk_down end,
           'price_change_24h', r.price_change_24h, 'price_usd', r.price_usd,
           'volume_24h', r.volume_24h, 'liquidity_usd', r.liquidity_usd),
         p_date
  from ranked r
  where (r.price_change_24h > 0 and r.rk_up <= 5) or (r.price_change_24h < 0 and r.rk_down <= 5)
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  -- volume spikes vs the token's own recent baseline.
  with base as (
    select tm.address, avg(tm.volume_24h) as avg_prev, count(*) as n
    from token_metrics tm
    where tm.chain = v_chain and tm.source = 'dexscreener' and tm.volume_24h is not null
      and tm.fetched_at >= now() - interval '7 days'
      and tm.fetched_at <  now() - interval '25 hours'
    group by tm.address
    having count(*) >= 200
  )
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select s.chain, 'volume_spike', s.address, s.symbol,
         format('%s volume is %sx its recent average', s.symbol, round(s.volume_24h / b.avg_prev, 1)),
         jsonb_build_object(
           'volume_24h', s.volume_24h, 'avg_prev_volume_24h', round(b.avg_prev, 2),
           'ratio', round(s.volume_24h / b.avg_prev, 2), 'liquidity_usd', s.liquidity_usd,
           'price_change_24h', s.price_change_24h),
         p_date
  from tmp_screener s
  join base b on b.address = s.address
  where s.chain = v_chain and b.avg_prev > 0
    and s.volume_24h >= 10000 and s.volume_24h >= 3 * b.avg_prev
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  -- holder concentration jumps.
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select cur.chain, 'holder_concentration_jump', cur.address, t.symbol,
         format('%s top-10 holders now own %s%% (up %s points in a day)', t.symbol, round(cur.top10_percent, 1), round(cur.top10_percent - prev.top10_percent, 1)),
         jsonb_build_object(
           'top10_percent', cur.top10_percent, 'top10_percent_prev', prev.top10_percent,
           'change_points', round(cur.top10_percent - prev.top10_percent, 2),
           'top20_percent', cur.top20_percent, 'holder_count', cur.holder_count),
         p_date
  from (
    select distinct on (hs.address) hs.*
    from token_holder_stats hs
    where hs.chain = v_chain
    order by hs.address, hs.fetched_at desc
  ) cur
  join tokens t on t.chain = cur.chain and t.address = cur.address
  join lateral (
    select p.top10_percent
    from token_holder_stats p
    where p.chain = cur.chain and p.address = cur.address
      and p.fetched_at <= now() - interval '20 hours'
      and p.fetched_at >= now() - interval '48 hours'
      and p.top10_percent is not null
    order by p.fetched_at desc
    limit 1
  ) prev on true
  where cur.fetched_at >= now() - interval '12 hours'
    and cur.top10_percent is not null
    and cur.top10_percent - prev.top10_percent >= 5
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  -- risk flags that appeared since yesterday (same rules as v_screener).
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select s.chain, 'new_risk_flag', s.address, s.symbol,
         format('%s flagged: %s', s.symbol, replace(s.risk_flag, '_', ' ')),
         jsonb_build_object(
           'risk_flag', s.risk_flag, 'vol_liq_ratio', round(s.vol_liq_ratio, 2),
           'volume_24h', s.volume_24h, 'liquidity_usd', s.liquidity_usd,
           'prev_volume_24h', prev.volume_24h, 'prev_liquidity_usd', prev.liquidity_usd),
         p_date
  from tmp_screener s
  join lateral (
    select m.volume_24h, m.liquidity_usd
    from token_metrics m
    where m.chain = s.chain and m.address = s.address and m.source = 'dexscreener'
      and m.volume_24h is not null and m.liquidity_usd is not null
      and m.fetched_at <= now() - interval '24 hours'
      and m.fetched_at >= now() - interval '48 hours'
    order by m.fetched_at desc
    limit 1
  ) prev on true
  where s.chain = v_chain and s.risk_flag is not null
    and not (prev.volume_24h / nullif(prev.liquidity_usd, 0) > 1000 or prev.liquidity_usd < 1000)
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  -- deployers that started selling (moving tokens out of their wallet).
  insert into insights (chain, type, token_address, symbol, headline, numbers, insight_date)
  select cur.chain, 'deployer_sold', cur.address, t.symbol,
         format('%s deployer has moved out %s%% of the tokens it received', t.symbol, round(cur.out_percent, 1)),
         jsonb_build_object(
           'deployer_address', cur.deployer_address, 'out_percent', cur.out_percent,
           'out_percent_prev', prev.out_percent, 'deployer_percent', cur.percent_of_supply,
           'deployer_percent_prev', prev.percent_of_supply),
         p_date
  from (
    select distinct on (x.address) x.*
    from token_deployer_snapshots x
    where x.chain = v_chain
    order by x.address, x.fetched_at desc
  ) cur
  join tokens t on t.chain = cur.chain and t.address = cur.address
  join lateral (
    select p.out_percent, p.percent_of_supply, p.has_sold
    from token_deployer_snapshots p
    where p.chain = cur.chain and p.address = cur.address and p.fetched_at < cur.fetched_at
    order by p.fetched_at desc
    limit 1
  ) prev on true
  where cur.has_sold is true and prev.has_sold is not true
    and cur.fetched_at >= now() - interval '26 hours'
  on conflict do nothing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  return v_total;
end
$$;
