-- wallets & entities: labeled addresses, per-token deployer tracking, and
-- the read-only views over them. additive only. everything is robinhood
-- chain (chain = 'robinhood') but keyed by chain like the rest of the schema.
--
-- addresses are stored lowercased everywhere, matching tokens / token_holders.
-- raw tables are service-role only (rls on, no policies, no anon grants); the
-- frontend reads the v_* views, which run as their owner.

-- ---------------------------------------------------------------- labels

create table if not exists entity_labels (
  id             bigint generated always as identity primary key,
  chain          text not null,
  address        text not null check (address = lower(address)),
  label          text not null,
  type           text not null check (type in ('deployer', 'team', 'cex', 'lp_pool', 'bridge', 'burn', 'smart_money')),
  -- null = the label applies to the address everywhere; set = only in the
  -- context of that token (e.g. "team wallet of X", "deployer of X").
  token_address  text,
  source         text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (chain, token_address) references tokens (chain, address) on delete cascade
);

create unique index if not exists idx_entity_labels_unique
  on entity_labels (chain, address, type, coalesce(token_address, ''));
create index if not exists idx_entity_labels_address on entity_labels (chain, address);

-- burn addresses are global and need no data source.
insert into entity_labels (chain, address, label, type, source) values
  ('robinhood', '0x0000000000000000000000000000000000000000', 'Zero address (burn)', 'burn', 'seed'),
  ('robinhood', '0x000000000000000000000000000000000000dead', 'Dead address (burn)', 'burn', 'seed')
on conflict do nothing;

-- ------------------------------------------------------------- deployers

-- when the worker last tried to resolve/refresh a token's deployer, so tokens
-- that keep failing rotate to the back of the queue (same pattern as
-- ohlcv_attempted_at / holders_attempted_at).
alter table tokens add column if not exists deployer_attempted_at timestamptz;

-- one row per token: who created it. deployer_address is the sender of the
-- creation transaction (an eoa in practice); creator_address is the contract
-- that executed the create, which differs when a factory deployed the token
-- (all the robinhood stock tokens are factory-created).
create table if not exists token_deployers (
  chain             text not null,
  address           text not null,
  deployer_address  text not null check (deployer_address = lower(deployer_address)),
  creator_address   text,
  creation_tx       text,
  deployed_at       timestamptz,
  detected_at       timestamptz not null default now(),
  primary key (chain, address),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);
create index if not exists idx_token_deployers_deployer on token_deployers (chain, deployer_address);

-- append-only history of the deployer's position in its own token. the latest
-- row is the current state; the previous one is what "has it sold since"
-- insights compare against.
--   out_percent: share of the tokens the deployer ever received that have left
--     its wallet (sold, added to liquidity, or sent elsewhere; the chain can't
--     tell those apart from here). null when it never received any.
--   transfers_complete: false when the deployer has more transfers than the
--     worker pages through, in which case out_percent is a partial view.
--   has_sold: out_percent >= 10; null when unknown (incomplete history and the
--     deployer still holds tokens).
create table if not exists token_deployer_snapshots (
  id                  bigint generated always as identity primary key,
  chain               text not null,
  address             text not null,
  deployer_address    text not null,
  balance             numeric,
  percent_of_supply   numeric,
  out_percent         numeric,
  transfers_seen      int,
  transfers_complete  boolean,
  has_sold            boolean,
  fetched_at          timestamptz not null default now(),
  foreign key (chain, address) references tokens (chain, address) on delete cascade
);
create index if not exists idx_token_deployer_snapshots_latest
  on token_deployer_snapshots (chain, address, fetched_at desc);

alter table entity_labels            enable row level security;
alter table token_deployers          enable row level security;
alter table token_deployer_snapshots enable row level security;
revoke all on entity_labels, token_deployers, token_deployer_snapshots from anon, authenticated;

-- ----------------------------------------------------------------- views

create or replace view v_entity_labels as
select chain, address, label, type, token_address, source, updated_at
from entity_labels;

-- per-token dev/insider position. insider_percent = deployer + wallets labeled
-- 'team' (for this token or globally) that appear in the stored top-20 holders;
-- a team wallet outside the top 20 is not visible to us, so it is a floor.
create or replace view v_token_dev as
select
  t.chain,
  t.address,
  t.symbol,
  t.name,
  d.deployer_address,
  d.creator_address,
  d.deployed_at,
  s.balance            as deployer_balance,
  s.percent_of_supply  as deployer_percent,
  s.out_percent        as deployer_out_percent,
  s.has_sold           as deployer_has_sold,
  s.transfers_complete as deployer_history_complete,
  coalesce(team.team_percent, 0) as team_percent,
  coalesce(team.team_wallets, 0) as team_wallets,
  coalesce(s.percent_of_supply, 0) + coalesce(team.team_percent, 0) as insider_percent,
  s.fetched_at         as refreshed_at
from token_deployers d
join tokens t on t.chain = d.chain and t.address = d.address
left join lateral (
  select * from token_deployer_snapshots x
  where x.chain = d.chain and x.address = d.address
  order by x.fetched_at desc
  limit 1
) s on true
left join lateral (
  select sum(th.percent_of_supply) as team_percent, count(*)::int as team_wallets
  from token_holders th
  where th.chain = d.chain and th.address = d.address
    and th.holder_address is not null
    and th.holder_address <> d.deployer_address
    and exists (
      select 1 from entity_labels el
      where el.chain = th.chain and el.address = th.holder_address and el.type = 'team'
        and (el.token_address is null or el.token_address = th.address)
    )
) team on true;

-- a wallet's positions among the stored top-20 holders of each tracked token.
-- filter with ?wallet_address=eq.0x... (lowercase).
create or replace view v_wallet_holdings as
select
  th.holder_address as wallet_address,
  th.chain,
  th.address        as token_address,
  t.symbol,
  t.name,
  t.image_url,
  th.rank,
  th.balance,
  th.percent_of_supply,
  th.is_contract,
  sc.price_usd,
  th.balance * sc.price_usd as value_usd,
  th.fetched_at
from token_holders th
join tokens t on t.chain = th.chain and t.address = th.address
left join v_screener sc on sc.chain = th.chain and sc.address = th.address
where th.holder_address is not null;

-- tokens a wallet deployed, with its current position in each.
create or replace view v_wallet_deployed as
select
  dv.deployer_address as wallet_address,
  dv.chain,
  dv.address          as token_address,
  dv.symbol,
  dv.name,
  dv.deployed_at,
  dv.deployer_percent,
  dv.deployer_out_percent,
  dv.deployer_has_sold
from v_token_dev dv;

-- one row per known wallet (top-20 holder, deployer, or labeled address).
create or replace view v_wallet_summary as
with wallets as (
  select chain, holder_address as wallet_address from token_holders where holder_address is not null
  union
  select chain, deployer_address from token_deployers
  union
  select chain, address from entity_labels
)
select
  w.chain,
  w.wallet_address,
  (select coalesce(jsonb_agg(jsonb_build_object('label', el.label, 'type', el.type, 'token_address', el.token_address)), '[]'::jsonb)
     from entity_labels el where el.chain = w.chain and el.address = w.wallet_address) as labels,
  (select count(*)::int from v_wallet_holdings h where h.chain = w.chain and h.wallet_address = w.wallet_address) as tokens_held,
  (select sum(h.value_usd) from v_wallet_holdings h where h.chain = w.chain and h.wallet_address = w.wallet_address) as total_value_usd,
  (select count(*)::int from token_deployers d where d.chain = w.chain and d.deployer_address = w.wallet_address) as tokens_deployed
from wallets w;

-- every new object starts with no anon access (default privileges were
-- revoked in 20261020000000); grant exactly the views.
alter view v_entity_labels   set (security_invoker = false);
alter view v_token_dev       set (security_invoker = false);
alter view v_wallet_holdings set (security_invoker = false);
alter view v_wallet_deployed set (security_invoker = false);
alter view v_wallet_summary  set (security_invoker = false);
revoke all on v_entity_labels, v_token_dev, v_wallet_holdings, v_wallet_deployed, v_wallet_summary from anon, authenticated;
grant select on v_entity_labels, v_token_dev, v_wallet_holdings, v_wallet_deployed, v_wallet_summary to anon, authenticated;

-- staleness alerting for the new worker jobs (see 20261020010000).
insert into worker_alert_config (worker_name, interval_seconds, alert_on_error) values
  ('blockscout_deployers', 1800, false),
  ('entity_labels',        1800, true)
on conflict (worker_name) do nothing;
