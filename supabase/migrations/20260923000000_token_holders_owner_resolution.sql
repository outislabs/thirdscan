-- alters the already-live token_holders / token_holder_stats tables to
-- match the owner-resolution design: token_account (the raw SPL token
-- account) is now distinct from holder_address (the resolved owner
-- wallet, nullable when resolution fails). see 20260922060000 for the
-- original intent -- that file was already applied live by the time this
-- was written, so it's left alone; this migration carries the changes
-- forward instead of editing it.

alter table token_holders add column if not exists token_account text;

-- backfill: under the schema this alters, holder_address held the raw
-- token account address (owner resolution didn't exist yet), so it's the
-- correct starting value for token_account on any rows already live. these
-- rows are a snapshot the holders job overwrites every cycle anyway, so
-- this is a reasonable stand-in until the next fetch replaces them for real.
update token_holders set token_account = holder_address where token_account is null;

alter table token_holders alter column token_account set not null;
alter table token_holders alter column holder_address drop not null;

alter table token_holders
  add constraint token_holders_chain_address_token_account_key
  unique (chain, address, token_account);

alter table token_holder_stats rename column top50_percent to top20_percent;

-- existing rows were computed under the old semantics: top20_percent held a
-- top-50 sum from the paginated getTokenAccounts method, and holder_count
-- was a real distinct-owner count from that same pagination. neither means
-- what its column now means -- top20_percent is top-20 largest-accounts by
-- balance, and holder_count is no longer computable at all -- so both are
-- wrong under the new label rather than merely stale. null them out instead
-- of leaving misleading values; the holders job will populate correct ones
-- going forward.
update token_holder_stats set top20_percent = null, holder_count = null;
