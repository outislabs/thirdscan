-- v_screener / v_token_profile now merge metrics across sources
-- (geckoterminal, dexscreener, ...): per field, take the newest non-null
-- value reported in the last 30 minutes, and report which source it came
-- from. token_metrics keeps one row per (source, fetched_at) per token, so
-- this never needs to overwrite anything -- it just picks the best row per
-- field at read time. tokens with no fresh price in any source (price_usd
-- still null after resolution) are excluded entirely.

drop view if exists v_screener;
drop view if exists v_token_profile;

create view v_screener as
select
  t.chain,
  t.address,
  t.symbol,
  t.name,
  t.decimals,
  t.is_rwa,
  t.created_at,
  price.price_usd,
  price.source as price_usd_source,
  price.is_estimate,
  vol.volume_24h,
  vol.source as volume_24h_source,
  liq.liquidity_usd,
  liq.source as liquidity_usd_source,
  mc.market_cap,
  mc.source as market_cap_source,
  chg.price_change_24h,
  chg.source as price_change_24h_source,
  greatest(price.fetched_at, vol.fetched_at, liq.fetched_at, mc.fetched_at, chg.fetched_at) as fetched_at
from tokens t
left join lateral (
  select price_usd, source, is_estimate, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.price_usd is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) price on true
left join lateral (
  select volume_24h, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.volume_24h is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) vol on true
left join lateral (
  select liquidity_usd, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.liquidity_usd is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) liq on true
left join lateral (
  select market_cap, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.market_cap is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) mc on true
left join lateral (
  select price_change_24h, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.price_change_24h is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) chg on true
where price.price_usd is not null;

create view v_token_profile as
select
  t.chain,
  t.address,
  t.pool_address,
  t.symbol,
  t.name,
  t.decimals,
  t.is_rwa,
  t.created_at,
  price.price_usd,
  price.source as price_usd_source,
  price.is_estimate,
  vol.volume_24h,
  vol.source as volume_24h_source,
  liq.liquidity_usd,
  liq.source as liquidity_usd_source,
  mc.market_cap,
  mc.source as market_cap_source,
  chg.price_change_24h,
  chg.source as price_change_24h_source,
  greatest(price.fetched_at, vol.fetched_at, liq.fetched_at, mc.fetched_at, chg.fetched_at) as fetched_at
from tokens t
left join lateral (
  select price_usd, source, is_estimate, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.price_usd is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) price on true
left join lateral (
  select volume_24h, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.volume_24h is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) vol on true
left join lateral (
  select liquidity_usd, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.liquidity_usd is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) liq on true
left join lateral (
  select market_cap, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.market_cap is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) mc on true
left join lateral (
  select price_change_24h, source, fetched_at
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
    and tm.price_change_24h is not null
    and tm.fetched_at >= now() - interval '30 minutes'
  order by tm.fetched_at desc
  limit 1
) chg on true
where price.price_usd is not null;

grant select on v_screener to anon;
grant select on v_token_profile to anon;
