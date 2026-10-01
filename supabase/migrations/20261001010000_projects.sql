-- curated protocol listings (dexes, launchpads, lenders, bridges, ...) per
-- chain. rows are maintained by hand, not by the worker. slug is the
-- stable url key, unique per chain. contract_addresses holds the
-- protocol's known contracts on that chain (routers, factories, vaults),
-- lowercased like token addresses; empty when none are recorded.

create table if not exists projects (
  id                  bigint generated always as identity primary key,
  chain               text not null,
  slug                text not null,
  name                text not null,
  category            text not null default 'other'
                        check (category in ('dex', 'launchpad', 'lending', 'bridge', 'explorer', 'infrastructure', 'other')),
  description         text,
  website_url         text,
  x_url               text,
  logo_url            text,
  contract_addresses  text[] not null default '{}',
  is_verified         boolean not null default false,
  added_at            timestamptz not null default now(),
  notes               text,
  unique (chain, slug)
);

create index if not exists idx_projects_chain_category
  on projects (chain, category);

comment on column projects.notes is
  'internal curation notes; not exposed through v_projects.';

alter table projects enable row level security;
-- no anon policy: same closed posture as tokens / token_holders. anon reads
-- only through v_projects below and has no write path.

-- same posture as the holder views (20260930010000): runs with the view
-- owner's privileges, so anon reads projects without a table policy.
-- notes is left out -- it's for curators, not the frontend.
create or replace view v_projects as
select
  p.id,
  p.chain,
  p.slug,
  p.name,
  p.category,
  p.description,
  p.website_url,
  p.x_url,
  p.logo_url,
  p.contract_addresses,
  p.is_verified,
  p.added_at
from projects p;

-- v_projects is a simple single-table view, so postgres treats it as
-- auto-updatable, and supabase's default privileges grant anon/authenticated
-- insert/update/delete on new objects in public. since the view runs as its
-- owner, that would let anon write to projects past rls. strip every
-- default grant and hand back select only.
revoke all on v_projects from anon, authenticated;

grant select on v_projects to anon;
