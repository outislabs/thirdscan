-- v_token_registry (20261001104842) was applied to the remote outside the
-- repo, and granted select without first revoking supabase's default
-- privileges. it's a simple single-table view over rwa_issuers, so postgres
-- treats it as auto-updatable, and since it runs as its owner, any default
-- insert/update/delete grant to anon/authenticated would let them write to
-- rwa_issuers past rls. same fix as the holder views (20260930010000):
-- strip every grant and hand back select only. authenticated keeps select
-- because 20261001104842 granted it explicitly.
--
-- the live state is snapshotted into security_audit before and after the
-- revoke, in this same transaction, so there's a durable record of what
-- was actually exposed.

-- audit trail for security-relevant fixes. service role only: rls on, no
-- policies, and the default anon/authenticated grants stripped.
create table if not exists security_audit (
  id           bigint generated always as identity primary key,
  recorded_at  timestamptz not null default now(),
  object_name  text not null,
  phase        text not null,
  detail       jsonb not null
);

alter table security_audit enable row level security;
revoke all on security_audit from anon, authenticated;

create function pg_temp.snapshot_v_token_registry(p_phase text) returns void
language sql as $$
  insert into security_audit (object_name, phase, detail)
  select
    'public.v_token_registry',
    p_phase,
    jsonb_build_object(
      'privileges', (
        select jsonb_object_agg(r.role, (
          select jsonb_object_agg(p.priv, has_table_privilege(r.role, 'public.v_token_registry', p.priv))
          from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
        ))
        from unnest(array['anon', 'authenticated']) r(role)
      ),
      'acl', c.relacl::text,
      'owner', pg_get_userbyid(c.relowner),
      -- security_invoker=true would mean rwa_issuers' rls still applies.
      'reloptions', c.reloptions,
      'is_insertable_into', v.is_insertable_into::text,
      'is_updatable', v.is_updatable::text,
      'base_table_rls_enabled', b.relrowsecurity,
      'base_table_policies', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', pol.policyname, 'cmd', pol.cmd, 'roles', pol.roles,
          'using', pol.qual, 'with_check', pol.with_check)), '[]'::jsonb)
        from pg_policies pol
        where pol.schemaname = 'public' and pol.tablename = 'rwa_issuers'
      )
    )
  from pg_class c
  join information_schema.views v
    on v.table_schema = 'public' and v.table_name = 'v_token_registry'
  cross join pg_class b
  where c.oid = 'public.v_token_registry'::regclass
    and b.oid = 'public.rwa_issuers'::regclass;
$$;

select pg_temp.snapshot_v_token_registry('before revoke');

revoke all on v_token_registry from anon, authenticated;

grant select on v_token_registry to anon;
grant select on v_token_registry to authenticated;

select pg_temp.snapshot_v_token_registry('after revoke');

-- fail the migration (rolling it back, snapshots included) if either role
-- can still write.
do $$
declare
  r text;
  p text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.v_token_registry', p) then
        raise exception 'v_token_registry: % still has % after revoke', r, p;
      end if;
    end loop;
    if not has_table_privilege(r, 'public.v_token_registry', 'SELECT') then
      raise exception 'v_token_registry: % lost SELECT', r;
    end if;
  end loop;
end
$$;
