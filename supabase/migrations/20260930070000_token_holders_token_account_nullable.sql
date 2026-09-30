-- token_account was made not null in 20260923000000 for solana, where each
-- holder row is an spl token account aggregated under its owner wallet. on
-- evm chains (robinhood) balances belong to wallets directly -- there is no
-- token account and no owner resolution step -- so those rows store the
-- wallet in holder_address and leave token_account null.
--
-- the unique (chain, address, token_account) constraint stays: postgres
-- treats nulls as distinct, so evm rows never collide on it, and evm rows
-- are identified by unique (chain, address, holder_address) instead.

alter table token_holders alter column token_account drop not null;

comment on column token_holders.token_account is
  'solana only: the spl token account (representative account when an owner holds several). null on evm chains, where holder_address is the wallet itself.';
