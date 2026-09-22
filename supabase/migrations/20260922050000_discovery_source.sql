-- tracks how a token entered the tokens table: 'liquidity' (primary
-- discovery, sorted by pool reserve -- the real tokens) or 'volume'
-- (secondary discovery, sorted by 24h volume -- high-volume outliers not
-- already found via liquidity).

alter table tokens add column if not exists discovery_source text;
