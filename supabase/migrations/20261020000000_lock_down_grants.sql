-- grant audit across every relation in public. supabase's default privileges
-- hand anon/authenticated full DML on anything created by postgres, and two
-- migrations were applied out-of-repo, so rather than trust per-object
-- revokes this resets the whole schema to one explicit allowlist:
--
--   select on the v_* views the frontend reads, plus worker_status
--   insert on early_access_signups (rls policy already allows with check true)
--   nothing else, so raw tables are unreadable by anon.
--
-- the views run as their owner, so they keep reading the raw tables.
-- service_role is untouched.

-- reset: every table, view, matview, foreign table and sequence in public.
do $$
declare
  r record;
begin
  for r in
    select c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence public.%I from anon, authenticated', r.relname);
    else
      execute format('revoke all on table public.%I from anon, authenticated', r.relname);
    end if;
  end loop;
end
$$;

-- allowlist.
grant select on
  v_screener,
  v_token_profile,
  v_token_ohlcv,
  v_token_holders,
  v_token_holder_stats,
  v_projects,
  v_token_registry,
  worker_status
to anon, authenticated;

grant insert on early_access_signups to anon, authenticated;

-- stop future objects created by this role from inheriting the wide default.
-- new views/tables now need an explicit grant in their own migration.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- fail (and roll back) unless the result is exactly the allowlist.
do $$
declare
  r record;
  allowed_select text[] := array[
    'v_screener', 'v_token_profile', 'v_token_ohlcv', 'v_token_holders',
    'v_token_holder_stats', 'v_projects', 'v_token_registry', 'worker_status'
  ];
  p text;
  role_name text;
  want boolean;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    foreach role_name in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        want := (p = 'SELECT' and r.relname = any (allowed_select))
             or (p = 'INSERT' and r.relname = 'early_access_signups');
        if has_table_privilege(role_name, format('public.%I', r.relname), p) is distinct from want then
          raise exception 'grant audit: % on % for % is %, expected %',
            p, r.relname, role_name, not want, want;
        end if;
      end loop;
    end loop;
  end loop;
end
$$;
