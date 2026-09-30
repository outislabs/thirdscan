-- labels each holder so the frontend can tell contracts (liquidity pools,
-- bridges, vaults) from wallets -- on robinhood chain the top holder is
-- often a pool contract (e.g. uniswap v4's PoolManager), which otherwise
-- reads as a single wallet holding most of the supply.
--   is_contract  blockscout's address.is_contract for the holder
--   label        blockscout's name for the holder address (verified
--                contract name, e.g. 'UniswapV3Pool'), else its ens name
-- both null on solana rows (not provided by the old helius path) and when
-- blockscout has no name for the address.

alter table token_holders add column if not exists is_contract boolean;
alter table token_holders add column if not exists label text;

-- same definition as 20260930010000, with is_contract and label appended
-- as trailing columns (create or replace view can only add at the end).
create or replace view v_token_holders as
select
  th.chain,
  th.address,
  th.rank,
  th.holder_address,
  th.token_account,
  th.balance,
  th.percent_of_supply,
  th.source,
  th.fetched_at,
  th.is_contract,
  th.label
from token_holders th;

-- grants carry over on create or replace, but restate the posture from
-- 20260930010000 so this file stands alone: select only for anon, no
-- default write grants on this auto-updatable view.
revoke all on v_token_holders from anon, authenticated;
grant select on v_token_holders to anon;
