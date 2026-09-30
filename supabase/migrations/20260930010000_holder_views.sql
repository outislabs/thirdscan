-- exposes holder data to the frontend. same posture as v_screener /
-- v_token_profile: token_holders and token_holder_stats keep rls on with no
-- anon policy, and anon reads them only through these views, which run
-- with the view owner's privileges.

-- latest stats snapshot per token. token_holder_stats is append-only
-- history (one row per holders fetch), so the frontend only ever wants the
-- newest row for a given (chain, address). holder_count is always null --
-- see 20260922060000 for why it isn't tracked.
create or replace view v_token_holder_stats as
select distinct on (hs.chain, hs.address)
  hs.chain,
  hs.address,
  hs.holder_count,
  hs.top10_percent,
  hs.top20_percent,
  hs.source,
  hs.fetched_at
from token_holder_stats hs
order by hs.chain, hs.address, hs.fetched_at desc;

-- current top-20 holders per token. token_holders is already a bounded
-- snapshot (cleared and re-inserted each fetch), so no filtering is needed;
-- query by (chain, address) and order by rank. holder_address is null when
-- owner resolution failed for that account -- token_account is always set.
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
  th.fetched_at
from token_holders th;

-- v_token_holders is a simple single-table view, so postgres treats it as
-- auto-updatable, and supabase's default privileges grant anon/authenticated
-- insert/update/delete on new objects in public. since the view runs as its
-- owner, that would let anon write to token_holders past rls. strip every
-- default grant from both views and hand back select only.
revoke all on v_token_holder_stats from anon, authenticated;
revoke all on v_token_holders from anon, authenticated;

grant select on v_token_holder_stats to anon;
grant select on v_token_holders to anon;
