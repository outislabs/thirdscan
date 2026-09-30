-- exposes hourly candles to the frontend. same posture as the holder views
-- (20260930010000): token_ohlcv keeps rls on with no anon policy, and anon
-- reads it only through this view, which runs with the view owner's
-- privileges.

-- hourly candles per token. token_ohlcv is already unique on
-- (chain, address, ts) -- the ohlcv job upserts, so reruns overwrite rather
-- than duplicate -- so no dedup is needed; query by (chain, address) and
-- filter/order by ts. rows older than the job's 7-day fetch window are kept,
-- not pruned, so filter on ts for a bounded chart range.
create or replace view v_token_ohlcv as
select
  o.chain,
  o.address,
  o.ts,
  o.open,
  o.high,
  o.low,
  o.close,
  o.volume_usd,
  o.source,
  o.fetched_at
from token_ohlcv o;

-- v_token_ohlcv is a simple single-table view, so postgres treats it as
-- auto-updatable, and supabase's default privileges grant anon/authenticated
-- insert/update/delete on new objects in public. since the view runs as its
-- owner, that would let anon write to token_ohlcv past rls. strip every
-- default grant and hand back select only.
revoke all on v_token_ohlcv from anon, authenticated;

grant select on v_token_ohlcv to anon;
