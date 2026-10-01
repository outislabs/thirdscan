-- records when the holders job last attempted a token, whether or not the
-- fetch succeeded. the job orders its selection by this (nulls first), so
-- tokens whose blockscout fetch keeps failing (and so never get a fresh
-- token_holder_stats row) go to the back of the queue after each attempt
-- instead of holding the front of it forever. same pattern as
-- ohlcv_attempted_at.

alter table tokens add column if not exists holders_attempted_at timestamptz;

comment on column tokens.holders_attempted_at is
  'when the holders job last attempted this token (set on every attempt, including failures); null = never attempted.';
