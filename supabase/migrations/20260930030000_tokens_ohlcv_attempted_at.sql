-- records when the ohlcv job last attempted a token, whether or not
-- candles came back. the job orders its selection by this (nulls first)
-- instead of by newest stored candle, so tokens that geckoterminal never
-- returns candles for (dead pools, no trades) go to the back of the queue
-- after each attempt instead of holding the front of it forever.

alter table tokens add column if not exists ohlcv_attempted_at timestamptz;

comment on column tokens.ohlcv_attempted_at is
  'when the ohlcv job last attempted this token (set on every attempt, including failures and empty responses); null = never attempted.';
