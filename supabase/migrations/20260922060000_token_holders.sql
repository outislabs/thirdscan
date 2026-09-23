-- token holder snapshots from helius, via getTokenLargestAccounts (top 20
-- accounts by balance, no pagination -- getTokenAccounts times out on large
-- mints like SOL/USDC). token_holders is a bounded top-20 snapshot per
-- token (cleared and re-inserted each fetch so stale holders don't linger);
-- token_holder_stats is append-only history, one row per fetch, like
-- token_metrics. holder_count is intentionally not tracked: the top-20
-- rpc call gives no way to know total holders without pagination, and we
-- don't estimate it.
--
-- holder_address is the resolved owner wallet (accounts under the same
-- owner are aggregated), not the token account itself -- that's kept
-- separately in token_account (the representative account for that owner,
-- the largest of their individual accounts if they hold more than one).
-- when owner resolution fails for an account, it's kept as its own row
-- with holder_address null rather than dropped or mislabeled as the owner.
-- holder_address can repeat as null across such rows (postgres doesn't
-- treat nulls as equal for uniqueness), so token_account -- always
-- present -- is the column that actually identifies a row; both are
-- still declared unique per token.

create table if not exists token_holders (
  id                 bigint generated always as identity primary key,
  chain              text not null,
  address            text not null,
  holder_address     text,
  token_account      text not null,
  balance            numeric,
  percent_of_supply  numeric,
  rank               int,
  source             text,
  fetched_at         timestamptz not null default now(),
  unique (chain, address, holder_address),
  unique (chain, address, token_account),
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
  top20_percent   numeric,
  source          text,
  fetched_at      timestamptz not null default now(),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);

create index if not exists idx_token_holder_stats_chain_address_fetched_at
  on token_holder_stats (chain, address, fetched_at desc);

alter table token_holders enable row level security;
alter table token_holder_stats enable row level security;
-- no anon policy on either: same closed posture as tokens / token_metrics / token_ohlcv.
