-- verified issuer registry: maps a mint address to a verified real-world
-- asset issuer. resolution is always by (chain, mint_address) -- never by
-- symbol or name, which are spoofable (see the TIKTOK/OpenAI duplicate-
-- symbol case from earlier in the schema's history).

create table if not exists rwa_issuers (
  id                   bigint generated always as identity primary key,
  chain                text not null,
  mint_address         text not null,
  issuer_name          text not null,
  asset_type           text not null check (asset_type in ('equity', 'commodity', 'treasury', 'other')),
  underlying_symbol    text,
  verified_source_url  text not null,
  added_at             timestamptz not null default now(),
  unique (chain, mint_address)
);

alter table rwa_issuers enable row level security;
-- no anon policy: same closed posture as the other supporting tables.
-- is_rwa / issuer_name reach anon only through v_screener / v_token_profile,
-- which run with the view owner's privileges.

-- v_screener.is_rwa now reflects registry membership (true iff a verified
-- row exists for this exact mint), replacing the old raw tokens.is_rwa
-- passthrough, which every worker currently just hardcodes to false.
-- issuer_name is appended as a new trailing column (null when unverified).
create or replace view v_screener as
select
  t.chain,
  t.address,
  t.symbol,
  t.name,
  t.decimals,
  (ri.mint_address is not null) as is_rwa,
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
  greatest(price.fetched_at, vol.fetched_at, liq.fetched_at, mc.fetched_at, chg.fetched_at) as fetched_at,
  vol.volume_24h / nullif(liq.liquidity_usd, 0) as vol_liq_ratio,
  case
    when vol.volume_24h / nullif(liq.liquidity_usd, 0) > 1000 then 'fake_volume'
    when liq.liquidity_usd < 1000 then 'low_liquidity'
    else null
  end as risk_flag,
  ri.issuer_name
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
left join rwa_issuers ri on ri.chain = t.chain and ri.mint_address = t.address
where price.price_usd is not null;

create or replace view v_token_profile as
select
  t.chain,
  t.address,
  t.pool_address,
  t.symbol,
  t.name,
  t.decimals,
  (ri.mint_address is not null) as is_rwa,
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
  greatest(price.fetched_at, vol.fetched_at, liq.fetched_at, mc.fetched_at, chg.fetched_at) as fetched_at,
  vol.volume_24h / nullif(liq.liquidity_usd, 0) as vol_liq_ratio,
  case
    when vol.volume_24h / nullif(liq.liquidity_usd, 0) > 1000 then 'fake_volume'
    when liq.liquidity_usd < 1000 then 'low_liquidity'
    else null
  end as risk_flag,
  ri.issuer_name
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
left join rwa_issuers ri on ri.chain = t.chain and ri.mint_address = t.address
where price.price_usd is not null;

grant select on v_screener to anon;
grant select on v_token_profile to anon;
