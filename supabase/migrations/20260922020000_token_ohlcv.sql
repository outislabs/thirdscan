-- token_ohlcv: hourly candles per token, plus the pool tokens were discovered from

alter table tokens add column if not exists pool_address text;

create table if not exists token_ohlcv (
  id          bigint generated always as identity primary key,
  chain       text not null,
  address     text not null,
  ts          timestamptz not null,
  open        numeric,
  high        numeric,
  low         numeric,
  close       numeric,
  volume_usd  numeric,
  source      text,
  fetched_at  timestamptz not null default now(),
  unique (chain, address, ts),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);

create index if not exists idx_token_ohlcv_chain_address_ts
  on token_ohlcv (chain, address, ts desc);

alter table token_ohlcv enable row level security;
-- no anon policy: token_ohlcv stays closed, same posture as tokens / token_metrics.

-- latest metrics + token info per token (same shape as v_screener, plus pool_address)
create or replace view v_token_profile as
select
  t.chain,
  t.address,
  t.pool_address,
  t.symbol,
  t.name,
  t.decimals,
  t.is_rwa,
  t.created_at,
  m.price_usd,
  m.volume_24h,
  m.liquidity_usd,
  m.market_cap,
  m.price_change_24h,
  m.source,
  m.fetched_at,
  m.is_estimate
from tokens t
left join lateral (
  select *
  from token_metrics tm
  where tm.chain = t.chain and tm.address = t.address
  order by tm.fetched_at desc
  limit 1
) m on true;

grant select on v_token_profile to anon;
