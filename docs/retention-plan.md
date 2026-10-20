# token_metrics retention plan (executed 2026-10-20: 1,183,706 rows thinned, backup in archive/)

Measured 2026-10-20 via service-role reads (row counts exact; sizes are estimates, see "Measure first").

## Current state

| | Rows |
|---|---|
| Total | ~1.83M (oldest 2026-09-22) |
| Older than 7 days | 1,324,670 (72%) |
| Newer than 7 days | 505,037 |
| By source | dexscreener 1.14M · geckoterminal 0.49M · jupiter 0.20M (frozen) |
| By chain | robinhood 1.45M · solana ~0.38M (frozen since 09-30) |

Ingest is ~72k rows/day, append-only. Nothing reads history: `v_screener` / `v_token_profile` only look back 30 minutes, and no worker code reads old `token_metrics`. Candle history lives in `token_ohlcv`. So old detail is only needed for future charts/analytics.

## Proposal

1. **Last 7 days: keep everything** (5-minute resolution).
2. **Older than 7 days: keep one row per (chain, address, source, hour)**, the latest in that hour. No new table: the surviving rows are ordinary `token_metrics` rows, so anything that can read the table can read them. (A separate rollup table with min/max/avg is not worth it: price high/low already exist in `token_ohlcv`, and the other columns are point-in-time snapshots where "last in the hour" is the natural value.)
3. **Run nightly** via pg_cron once approved, so the table plateaus instead of growing.

Sampled 50 tokens (25 per chain) to estimate the thinning ratio: 29,989 old rows collapse to 3,048 hourly rows, i.e. **keep ~10%** (robinhood 9.6%, solana 11.1%).

## Expected effect (one-off)

| | Rows |
|---|---|
| Now | 1,829,707 |
| Delete (older than 7d, non-hourly) | ~1.19M (~65% of table) |
| After | ~640k (505k raw + ~135k hourly) |
| Steady state | ~505k raw + ~7k/day hourly rows added |

Steady-state growth after the first pass is ~6–7k hourly rows/day (about 10% of the 72k/day raw rate), versus 72k/day now: a **~10x slower** long-term growth, and the lateral lookups in `v_screener` stay on a table of ~0.6M rows.

Space: rows are ~200 bytes of heap (bigint id, two text, five numerics, timestamp, bool, 24-byte header) plus two indexes (pkey and `chain, address, fetched_at desc`), roughly **300–350 bytes/row all-in, so ~0.55–0.65 GB now, ~0.2 GB after, saving ~0.35–0.45 GB**. This is an estimate: I cannot run `pg_total_relation_size` from here. Note that `DELETE` alone does not shrink files on disk: autovacuum makes the space reusable (the table stops growing for a while) but returning it to the OS needs `VACUUM FULL` (takes an exclusive lock) or `pg_repack`. At this size `VACUUM FULL` is a few seconds to under a minute; schedule it for a quiet moment, or skip it and let the plateau do the work.

## Measure first

```sql
select pg_size_pretty(pg_total_relation_size('public.token_metrics')) as total,
       pg_size_pretty(pg_relation_size('public.token_metrics'))       as heap,
       pg_size_pretty(pg_indexes_size('public.token_metrics'))        as indexes;

-- how many rows the thinning would delete (read-only)
select count(*) as to_delete
from token_metrics
where fetched_at < now() - interval '7 days'
  and id not in (
    select distinct on (chain, address, source, date_trunc('hour', fetched_at)) id
    from token_metrics
    where fetched_at < now() - interval '7 days'
    order by chain, address, source, date_trunc('hour', fetched_at), fetched_at desc
  );
```

## The delete (NOT run; needs your go-ahead)

Destructive and irreversible. Take a backup first (Supabase dashboard > Database > Backups, or `pg_dump -t token_metrics`). Do it in id-range batches to avoid one long lock/WAL spike:

```sql
-- keep-set: latest row per (chain, address, source, hour) among old rows
create temp table keep_ids as
select distinct on (chain, address, source, date_trunc('hour', fetched_at)) id
from token_metrics
where fetched_at < now() - interval '7 days'
order by chain, address, source, date_trunc('hour', fetched_at), fetched_at desc;

-- repeat until 0 rows deleted
delete from token_metrics
where id in (
  select id from token_metrics
  where fetched_at < now() - interval '7 days'
    and id not in (select id from keep_ids)
  limit 50000
);
```

Nightly job after approval (sketch):

```sql
select cron.schedule('token-metrics-retention', '17 3 * * *', $$
  delete from token_metrics
  where fetched_at < now() - interval '7 days'
    and id not in (
      select distinct on (chain, address, source, date_trunc('hour', fetched_at)) id
      from token_metrics
      where fetched_at < now() - interval '7 days'
      order by chain, address, source, date_trunc('hour', fetched_at), fetched_at desc
    );
$$);
```
(The nightly form re-thins the whole old region each night; if that gets slow, bound it to `fetched_at between now() - interval '9 days' and now() - interval '7 days'`.)

## Decisions for you

- Is hourly granularity beyond 7 days enough, or do you want daily after 90 days?
- Should the frozen Solana rows (~0.38M, listed in STATUS.md) be archived instead of thinned?
- OK to run the one-off delete, and do you want `VACUUM FULL` afterwards?
