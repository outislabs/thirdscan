-- thirdscan initial schema
-- onchain analytics: tokens + metrics + worker health, chain-agnostic (solana only for now)

create table if not exists tokens (
  id           bigint generated always as identity primary key,
  chain        text not null,
  address      text not null,
  symbol       text,
  name         text,
  decimals     int,
  is_rwa       boolean,
  created_at   timestamptz not null default now(),
  unique (chain, address)
);

create table if not exists token_metrics (
  id                bigint generated always as identity primary key,
  chain             text not null,
  address           text not null,
  price_usd         numeric,
  volume_24h        numeric,
  liquidity_usd     numeric,
  market_cap        numeric,
  price_change_24h  numeric,
  source            text,
  fetched_at        timestamptz not null default now(),
  is_estimate       boolean,
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);

create index if not exists idx_token_metrics_chain_address_fetched_at
  on token_metrics (chain, address, fetched_at desc);

create table if not exists worker_status (
  worker_name  text primary key,
  last_run_at  timestamptz,
  last_error   text
);

-- latest metrics row per token, joined to token metadata
create or replace view v_screener as
select
  t.chain,
  t.address,
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

-- RLS: lock down base tables, expose only v_screener and worker_status to anon
alter table tokens enable row level security;
alter table token_metrics enable row level security;
alter table worker_status enable row level security;

-- no anon policies on tokens / token_metrics: anon reads them only through v_screener,
-- which runs with the view owner's privileges (postgres views check permissions as
-- the owner, not the invoker), so RLS here stays fully closed to anon/authenticated.

create policy "worker_status select for anon"
  on worker_status
  for select
  to anon
  using (true);

grant select on v_screener to anon;
grant select on worker_status to anon;
