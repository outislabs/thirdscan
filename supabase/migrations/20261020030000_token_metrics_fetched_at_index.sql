-- thin_token_metrics filters on fetched_at windows only; the existing index
-- leads with (chain, address), so without this every call scans the table
-- and hits the statement timeout.
create index if not exists idx_token_metrics_fetched_at
  on token_metrics (fetched_at);
