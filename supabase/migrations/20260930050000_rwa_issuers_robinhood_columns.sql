-- adds the columns needed to register robinhood chain stock tokens in
-- rwa_issuers (seeded in 20260930060000). each gets its own column rather
-- than reusing an existing one with different meaning:
--   token_name          tokenName, e.g. 'Salesforce • Robinhood Token'
--   logo_url            logoUrl (issuer-hosted logo)
--   token_decimals      tokenDecimals
--   isin                isin of the underlying security -- the same
--                       identifier xstocks carries as underlyingIsin in
--                       raw_payload, so it can join the two issuers' tokens
--                       for the same stock
--   current_multiplier  currentMultiplier, kept exact as numeric (the api
--                       returns an 18-decimal string)
--   status              the issuer's own asset status, e.g.
--                       'ASSET_STATUS_ACTIVE'
-- all nullable: existing solana (xstocks) rows leave them null; their
-- equivalents stay in raw_payload.

alter table rwa_issuers add column if not exists token_name text;
alter table rwa_issuers add column if not exists logo_url text;
alter table rwa_issuers add column if not exists token_decimals int;
alter table rwa_issuers add column if not exists isin text;
alter table rwa_issuers add column if not exists current_multiplier numeric;
alter table rwa_issuers add column if not exists status text;
