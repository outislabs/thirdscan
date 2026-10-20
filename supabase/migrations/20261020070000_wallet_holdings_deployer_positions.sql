-- v_wallet_holdings only saw the stored top-20 holders, so a deployer sitting
-- on most of a token's supply could show no holdings (token_holders is not
-- refreshed for risk-flagged tokens). add the deployer's own tracked position
-- when it isn't already a stored top holder. `source` (trailing column) says
-- which rows came from where.
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
  th.fetched_at,
  'top_holders'::text as source
from token_holders th
join tokens t on t.chain = th.chain and t.address = th.address
left join v_screener sc on sc.chain = th.chain and sc.address = th.address
where th.holder_address is not null
union all
select
  dv.deployer_address,
  dv.chain,
  dv.address,
  dv.symbol,
  dv.name,
  t.image_url,
  null::int,
  dv.deployer_balance,
  dv.deployer_percent,
  false,
  sc.price_usd,
  dv.deployer_balance * sc.price_usd,
  dv.refreshed_at,
  'deployer_snapshot'::text
from v_token_dev dv
join tokens t on t.chain = dv.chain and t.address = dv.address
left join v_screener sc on sc.chain = dv.chain and sc.address = dv.address
where dv.deployer_balance > 0
  and not exists (
    select 1 from token_holders th
    where th.chain = dv.chain and th.address = dv.address and th.holder_address = dv.deployer_address
  );
