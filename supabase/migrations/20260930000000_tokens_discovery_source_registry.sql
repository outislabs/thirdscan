-- ensures tokens.discovery_source exists and documents the full set of
-- values now that the registry seed writes a third one. 20260922050000
-- added this column and is recorded as applied on remote, but the column
-- was found missing there -- add column if not exists covers both cases.

alter table tokens add column if not exists discovery_source text;

comment on column tokens.discovery_source is
  'how the token entered tokens: '
  '''liquidity'' = pool discovery sorted by pool reserve (primary); '
  '''volume'' = pool discovery sorted by 24h volume (secondary, outliers not found via liquidity); '
  '''registry'' = mint seeded from rwa_issuers -- authoritative (verified issuer), not ranked.';
