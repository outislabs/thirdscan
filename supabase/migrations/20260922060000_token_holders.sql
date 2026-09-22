-- token holder snapshots from helius. token_holders is a bounded top-100
-- snapshot per token (upsert target via the unique key, cleared and
-- re-inserted each fetch so stale holders don't linger); token_holder_stats
-- is append-only history, one row per fetch, like token_metrics.

create table if not exists token_holders (
  id                 bigint generated always as identity primary key,
  chain              text not null,
  address            text not null,
  holder_address     text not null,
  balance            numeric,
  percent_of_supply  numeric,
  rank               int,
  source             text,
  fetched_at         timestamptz not null default now(),
  unique (chain, address, holder_address),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);

create index if not exists idx_token_holders_chain_address_rank
  on token_holders (chain, address, rank);

create table if not exists token_holder_stats (
  id              bigint generated always as identity primary key,
  chain           text not null,
  address         text not null,
  holder_count    int,
  top10_percent   numeric,
  top50_percent   numeric,
  source          text,
  fetched_at      timestamptz not null default now(),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);

create index if not exists idx_token_holder_stats_chain_address_fetched_at
  on token_holder_stats (chain, address, fetched_at desc);

alter table token_holders enable row level security;
alter table token_holder_stats enable row level security;
-- no anon policy on either: same closed posture as tokens / token_metrics / token_ohlcv.
